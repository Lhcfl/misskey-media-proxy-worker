# Misskey Media Proxy Worker

[misskey-dev/media-proxy](https://github.com/misskey-dev/media-proxy) 的 **Cloudflare Workers** 重构实现。

原版是一个基于 Fastify + sharp.js + 临时文件的独立 Node.js 服务；本项目在保持
**对外行为兼容** 的前提下，将其重写为 **无服务器、无状态、无文件系统** 的 Worker：

- 没有数据库；
- 不再把文件写入磁盘，也不再依赖 sharp / got / tmp；
- 图片转换交给 Cloudflare 原生的 Image Resizing（`cf.image`）；
- 保留媒体代理的核心安全语义：**只用魔数决定 Content-Type、绝不原样返回 SVG、
  附加 CSP 与 `nosniff`、校验 SSRF**。

> 与原版一样，本项目的意义在于：由实例管理员自己的域名转发远端媒体，
> 从而避免把第三方站点的内容直接暴露在 Misskey 域名下，降低 XSS / 追踪风险。

---

## 目录

- [为什么可以不用 Fastify](#为什么可以不用-fastify)
- [架构对比](#架构对比)
- [快速开始](#快速开始)
- [配置项](#配置项)
- [HTTP 接口](#http-接口)
- [请求处理流程](#请求处理流程)
- [安全设计](#安全设计)
- [已知差异与限制](#已知差异与限制)
- [接入 Misskey](#接入-misskey)
- [开发与测试](#开发与测试)
- [目录结构](#目录结构)
- [License](#license)

---

## 为什么可以不用 Fastify

原版使用 Fastify 只是为了：

1. 提供一个 HTTP 路由（`GET /:url*`）；
2. 静态托管一张 fallback 占位图；
3. 在 `onRequest` 钩子里统一附上 CORS / CSP 响应头。

这些能力在 Workers 里都是平台内置的（`fetch` 处理器、模块打包、响应头构造），
而原版真正繁重的部分——**下载、类型探测、图片转换**——则各有更合适的替代：

| 原版实现 | Worker 实现 | 说明 |
| --- | --- | --- |
| Fastify 路由 | `export default { fetch() }` | 路由分发在 `src/index.ts` |
| `@fastify/static` 托管 dummy.png | Wrangler `Data` 模块导入 | `assets/dummy.png` 打包为 `ArrayBuffer` |
| got 下载到临时文件 | `fetch()` + 流式读取 | 内存只保留头部 4KB 用于探测 |
| `file-type`（读文件） | 纯函数 magic bytes 探测 | `src/file-info.ts`，无 I/O |
| `is-svg`（读整个文件） | 头部正则判定 | 只看前 4KB |
| sharp.js 转换 | Cloudflare Image Resizing | `fetch(url, { cf: { image } })` |
| `tmp` 临时文件 + cleanup | 不存在 | 流式转发，无需清理 |
| `hpagent` 正向代理 | 平台不支持 | 见[限制](#已知差异与限制) |
| `ipaddr.js` 校验 `res.ip` | 字面量校验 + 平台兜底 | 见[安全设计](#安全设计) |

---

## 架构对比

```
原版（Node.js）
  Client ──► Fastify ──► got ──► 临时文件 ──► file-type ──► sharp ──► 响应流
                                          └─► cleanup()

Worker
  Client ──► fetch handler ──► fetch(url, { cf.image? }) ──► 响应流
                                   │
                                   ├─ 头部 4KB：magic bytes 探测
                                   └─ 剩余：流式转发 + 大小限制
```

关键差别：原版「先落盘再处理」，Worker「边收边转边发」，因此没有临时文件、
也不需要 `cleanup()`，但代价是无法在响应前知道完整文件大小（见限制）。

---

## 快速开始

### 1. 安装依赖

```fish
pnpm install
```

### 2. 本地开发

```fish
pnpm dev
# 访问 http://localhost:8787/proxy?url=https%3A%2F%2Fwww.google.com%2Fimages%2Ferrors%2Frobot.png
```

> 本地 `wrangler dev` 会用**低保真模拟**处理 `cf.image`（仅支持 resize / rotate /
> format / background 等子集）。真实的转换效果需要部署后验证。

### 3. 部署

```fish
pnpm deploy
```

部署后你会得到形如 `https://misskey-media-proxy-worker.<account>.workers.dev` 的地址。

### 4. （可选）绑定自定义域名

编辑 `wrangler.toml`：

```toml
routes = [
  { pattern = "mediaproxy.example.com", custom_domain = true },
]
```

---

## 配置项

所有配置通过 `wrangler.toml` 的 `[vars]` 提供（见 `src/config.ts`）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `USER_AGENT` | `MisskeyMediaProxyWorker/1.0.0` | 请求远端时使用的 UA |
| `ALLOWED_PRIVATE_NETWORKS` | 空 | 允许访问的私有网段 CIDR，逗号分隔 |
| `MAX_SIZE` | `262144000`（250 MiB） | 单文件最大字节数 |
| `CORS_ALLOW_ORIGIN` | `*` | `Access-Control-Allow-Origin` |
| `CORS_ALLOW_HEADERS` | `*` | `Access-Control-Allow-Headers` |
| `CONTENT_SECURITY_POLICY` | `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'` | 返回的 CSP |
| `ENABLE_IMAGE_RESIZING` | `true` | 设为 `false` 时，转换请求返回 `501`，纯代理仍可用 |

---

## HTTP 接口

路由形式与原版一致，兼容两种写法：

1. **查询参数**：

   ```
   GET /proxy/image.webp?url=<URL-encoded source url>
   ```

   路径部分（`/proxy/image.webp`）只用于让 CDN 依据扩展名决定缓存行为，
   真正被代理的地址来自 `url` 查询参数。

2. **通配路径**：

   ```
   GET /example.com/path/to/image.png
   ```

   等价于 `url=https://example.com/path/to/image.png`。

### 查询参数一览

| 参数 | 说明 |
| --- | --- |
| `url`（必需） | 待代理/转换的源 URL。缺失或为空返回 `400`。 |
| `origin` | 原版用于「本体媒体代理不重定向到外部代理」，**独立代理下无效果**，保留兼容。 |
| `fallback` | 存在时，出错或转换失败会返回一张占位图（HTTP `200`，`Cache-Control: max-age=300`）。 |
| `emoji` | 返回高度 ≤ 128px 的 WebP，保留动画。 |
| `avatar` | 返回高度 ≤ 320px 的 WebP，保留动画。 |
| `static` | 只取第一帧的静态 WebP；单独使用时限制在 498×422 内。 |
| `preview` | 返回限制在 200×200 内的 WebP。 |
| `badge` | 返回 96×96 的 PNG，用于 Web Push 通知徽章。 |

转换分支的优先级与原版一致：`emoji`/`avatar` → `static` → `preview` → `badge`。

### 响应头

| 场景 | Content-Type | Cache-Control |
| --- | --- | --- |
| 正常 | 由魔数（或转换结果）决定 | `max-age=31536000, immutable` |
| 出错 | 无 | `max-age=300` |
| fallback 占位图 | `image/png` | `max-age=300` |

所有响应都会附带：

```
Access-Control-Allow-Origin:  <CORS_ALLOW_ORIGIN>
Access-Control-Allow-Headers: <CORS_ALLOW_HEADERS>
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
Content-Security-Policy:      <CONTENT_SECURITY_POLICY>
X-Content-Type-Options:       nosniff
```

### 使用示例

```fish
# 纯代理
curl -I "http://localhost:8787/proxy?url=https%3A%2F%2Fexample.com%2Fa.png"

# 头像
curl -I "http://localhost:8787/proxy?url=https%3A%2F%2Fexample.com%2Fa.png&avatar=1"

# 通配路径形式
curl -I "http://localhost:8787/example.com/a.png"
```

---

## 请求处理流程

```
                        ┌──────────────────────────────┐
  Request ──► 解析 URL ─┤ 有 url 查询？否则用路径拼接  │
                        └──────────────┬───────────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │ 有转换查询(emoji/avatar/...)？│
                        └───────┬───────────────┬───────┘
                          是    │               │  否
                ┌───────────────▼───┐     ┌─────▼────────────────────┐
                │ downloadUrl(带    │     │ downloadUrl(不带 cf.image)│
                │  cf.image 选项)   │     │ detectType(前 4KB)        │
                │ 校验输出为图片    │     │ ├─ SVG → 重新用 cf.image  │
                │ 失败 → 404        │     │ │        转 WebP          │
                └───────────────┬───┘     │ ├─ 非白名单 → 403         │
                                │         │ └─ 其它 → 原样转发        │
                                │         └─────────────┬────────────┘
                                └───────────┬───────────┘
                                            ▼
                        构建响应（Content-Type / Cache-Control /
                        Content-Disposition）──► 附加公共响应头 ──► 返回
```

错误最终统一进入 `errorResponse()`，与原版 `errorHandler` 行为一致。

---

## 安全设计

1. **只用魔数决定 `Content-Type`**
   不信任上游声明的 `Content-Type`，避免「声明为图片、实为 HTML/脚本」。

2. **绝不原样返回 SVG**
   SVG 可内嵌脚本。原版会把 SVG 转成 WebP；本实现同样通过 `cf.image` 转换后返回。

3. **只允许白名单类型 inline 展示**
   与 Misskey 的 `FILE_TYPE_BROWSERSAFE` 保持一致，其余类型返回 `403`。

4. **CSP + `X-Content-Type-Options: nosniff`**
   即使内容被误当作其它类型解析，也无法执行脚本。

5. **`Content-Disposition: inline` + 安全文件名**
   同时输出 ASCII 回退名与 RFC 5987 的 UTF-8 文件名，避免头注入。

6. **SSRF 防护**
   - 仅允许 `http` / `https`；
   - 拒绝 `localhost`、`*.localhost`、`*.local`、`*.internal`、`*.home.arpa`；
   - 拒绝字面量私有 IP（IPv4 / IPv6 / IPv4-mapped IPv6）；
   - 可用 `ALLOWED_PRIVATE_NETWORKS` 显式放行指定 CIDR；
   - `wrangler.toml` 启用 `global_fetch_strictly_public` 兼容性标志作为平台层兜底。

7. **大小限制**
   - 先检查上游 `Content-Length`；
   - 流式读取时累加计数，超限即中断（`413`）。

---

## 已知差异与限制

这是从 Node.js 迁移到 Workers 后**无法完全抹平**的差异，请务必阅读。

1. **`badge` 不再输出单色蒙版。**
   原版用 sharp 做「灰度 → 归一化 → 提高对比度 → 只保留 alpha 通道」，
   产出单色徽章；`cf.image` 不提供灰度 / 通道运算，因此本实现只能返回
   96×96 的彩色 PNG。Web Push 客户端通常仍能显示，但观感与原版不同。

2. **`emoji` / `avatar` 对 APNG 的处理不同。**
   原版对 APNG 会原样返回；本实现交给 `cf.image`，可能被转换为（动画）WebP。

3. **无法在响应前得知完整大小。**
   流式转发意味着：若上游未提供 `Content-Length` 且内容超过 `MAX_SIZE`，
   客户端可能先收到 `200`，随后连接被中断。响应头中可能带有
   上游的 `Content-Length`。若上游提供了 `Content-Length`，则会在发送正文前
   直接以 `413` 拒绝。

4. **不支持正向代理（`HTTP_PROXY` / `proxy` 配置）。**
   Workers 的 `fetch` 不提供可配置的 Agent，无法走 HTTP(S) 正向代理。
   如需固定出口，请在 Cloudflare 侧使用 Gateway / egress 方案。

5. **无法在应用层校验 DNS 解析结果。**
   `fetch()` 不暴露实际连接的 IP，因此 SSRF 只能做字面量与主机名校验，
   其余依赖平台网络层。理论上存在 DNS rebinding 窗口。

6. **需要可用且已开通的 Image Resizing。**
   `cf.image` 在 `*.workers.dev` 上可用，但转换按账号计费；
   若未开通 / 被禁用，请将 `ENABLE_IMAGE_RESIZING` 设为 `false`（转换请求返回 501）。

7. **`quality` 无法完全对齐。**
   原版 WebP 参数为 `quality:77, alphaQuality:95, effort:2`；
   `cf.image` 只暴露 `quality` 与 `format`，其余不可控。

8. **`api/xml` 通用 XML 不再单独识别。**
   原版会先识别 `application/xml` 再判断是否 SVG；本实现直接对头部做 SVG 正则判定，
   结果等价，但会减少一次类型分支。

9. **本地 `wrangler dev` 的 `cf.image` 只是低保真模拟。**
   真实转换效果需部署验证。

---

## 接入 Misskey

在 Misskey 的 `default.yml` 中加入：

```yml
mediaProxy: https://mediaproxy.example.com
```

然后重启 Misskey。客户端会依据 `api/meta` 中的 `mediaProxy` 字段，
把形如 `<mediaProxy>/proxy/image.webp?url=...` 的请求发送到本 Worker。

---

## 开发与测试

```fish
# 类型检查
pnpm typecheck

# 单元测试（vitest）
pnpm test

# 监听模式
pnpm test:watch

# 本地运行
pnpm dev
```

单元测试覆盖：

- `test/file-info.test.ts`：各类 magic bytes 与 SVG 探测；
- `test/image-processor.test.ts`：转换查询 → `cf.image` 选项映射；
- `test/ssrf.test.ts`：URL / 私有地址校验；
- `test/content-disposition.test.ts`：文件名与 `Content-Disposition` 处理。

---

## 目录结构

```
.
├── assets/
│   └── dummy.png              # fallback 占位图（来自原项目）
├── src/
│   ├── index.ts               # Worker 入口：路由、错误处理、公共响应头
│   ├── config.ts              # 从 env 解析运行时配置
│   ├── const.ts               # MIME 白名单、尺寸常量
│   ├── file-info.ts           # 纯函数 magic bytes 类型探测 + SVG 判定
│   ├── image-processor.ts     # 转换查询 → cf.image 选项
│   ├── download.ts            # fetch 下载 + 流式大小限制 + 头部窥探
│   ├── ssrf.ts                # SSRF 校验（CIDR / 保留主机名）
│   ├── content-disposition.ts # 文件名与 Content-Disposition
│   ├── status-error.ts        # 带状态码的错误类型
│   └── types.d.ts             # *.png Data 模块类型声明
├── test/                      # vitest 单元测试
├── wrangler.toml              # Worker 部署与运行时配置
├── tsconfig.json
└── package.json
```

---

## License

本项目是 [misskey-dev/media-proxy](https://github.com/misskey-dev/media-proxy)
的衍生作品，沿用其 **AGPL-3.0-or-later** 许可，详见 [LICENSE](./LICENSE)。
原项目的作者为 syuilo 与 tamaina。`assets/dummy.png` 亦来自原项目。
