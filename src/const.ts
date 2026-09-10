/**
 * 常量定义。
 *
 * 这些常量刻意与原版 `misskey-media-proxy`（以及 Misskey 本体）保持一致，
 * 以保证重构后行为兼容。见原仓库 `src/const.ts`。
 */

/**
 * 允许浏览器直接渲染（inline 展示）的 MIME 类型白名单。
 *
 * 不在该列表中的内容会被当作 `application/octet-stream` 处理，
 * 或直接被拒绝（见 `index.ts` 的安全检查分支）。
 *
 * 注意：SVG **不在**此列表中。SVG 可以内嵌脚本与外部引用，直接以内联方式
 * 返回会带来 XSS 风险，因此 SVG 会被强制转换为 WebP 后返回。
 *
 * 参考：
 * - https://github.com/sindresorhus/file-type/blob/main/supported.js
 * - https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Containers
 */
export const FILE_TYPE_BROWSERSAFE: readonly string[] = [
	// 图片
	'image/png',
	'image/gif',
	'image/jpeg',
	'image/webp',
	'image/avif',
	'image/apng',
	'image/bmp',
	'image/tiff',
	'image/x-icon',

	// OggS 容器
	'audio/opus',
	'video/ogg',
	'audio/ogg',
	'application/ogg',

	// ISO/IEC base media file format（MP4 家族）
	'video/quicktime',
	'video/mp4',
	'audio/mp4',
	'video/x-m4v',
	'audio/x-m4a',
	'video/3gpp',
	'video/3gpp2',

	'video/mpeg',
	'audio/mpeg',

	'video/webm',
	'audio/webm',

	'audio/aac',

	// https://github.com/misskey-dev/misskey/pull/10686
	'audio/flac',
	'audio/wav',
	// 向后兼容的旧 MIME
	'audio/x-flac',
	'audio/vnd.wave',
];

/**
 * 可由服务端图像库（原版为 sharp.js）解码并转换的图片类型。
 *
 * 在 Cloudflare Workers 版本中，实际转换由 Cloudflare Image Resizing
 * (`cf.image`) 完成，但该判定仍用于决定“是否允许对某个类型应用转换查询”。
 */
export const SHARP_CONVERTIBLE_IMAGE: readonly string[] = [
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/apng',
	'image/vnd.mozilla.apng',
	'image/webp',
	'image/avif',
	'image/svg+xml',
	'image/x-icon',
	'image/bmp',
];

/**
 * 可由“支持动画”的图像管线处理的类型。
 *
 * 原版用于决定 `emoji` / `avatar` 在未指定 `static` 时是否保留动画。
 * 这里保留该列表以便行为对齐与文档说明。
 */
export const SHARP_ANIMATION_CONVERTIBLE_IMAGE: readonly string[] = [
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif',
	'image/svg+xml',
	'image/x-icon',
	'image/bmp',
];

/**
 * 各转换查询的语义（与原版 SPECIFICATION.md 对齐）：
 *
 * | 查询      | 输出                                                        |
 * | --------- | ----------------------------------------------------------- |
 * | `emoji`   | 高度 ≤ 128px 的 WebP（保留动画）                            |
 * | `avatar`  | 高度 ≤ 320px 的 WebP（保留动画）                            |
 * | `static`  | 仅第一帧的静态 WebP；单独出现时限制在 498x422 内            |
 * | `preview` | 限制在 200x200 内的 WebP                                    |
 * | `badge`   | 96x96 的 PNG（Web Push 通知徽章）                           |
 *
 * 这些值用于 `image-processor.ts` 构造 `cf.image` 选项。
 */
export const EMOJI_HEIGHT = 128;
export const AVATAR_HEIGHT = 320;
export const STATIC_WIDTH = 498;
export const STATIC_HEIGHT = 422;
export const PREVIEW_SIZE = 200;
export const BADGE_SIZE = 96;
export const SVG_CONVERT_SIZE = 2048;

/** 原版 WebP 默认质量（sharp `webpDefault.quality`）。 */
export const WEBP_QUALITY = 77;

/** 读取远端内容时用于探测文件类型的头部字节数。 */
export const PEEK_SIZE = 4096;

/**
 * 默认最大下载体积（字节）。250 MiB，与原版 `defaultDownloadConfig.maxSize` 相同。
 *
 * Workers 版本通过流式读取 + 计数来强制执行该上限，因此不会把整个文件读入内存。
 */
export const DEFAULT_MAX_SIZE = 262_144_000;

/** 正常响应使用的 Cache-Control（一年 + immutable）。 */
export const CACHE_CONTROL_SUCCESS = 'max-age=31536000, immutable';

/** 错误 / fallback 响应使用的 Cache-Control。 */
export const CACHE_CONTROL_ERROR = 'max-age=300';

/** 默认 Content-Security-Policy，与原版一致。 */
export const DEFAULT_CSP = `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'`;

/** 默认 User-Agent。 */
export const DEFAULT_USER_AGENT = `MisskeyMediaProxyWorker/1.0.0`;
