/**
 * SSRF（服务端请求伪造）防护。
 *
 * 原版通过 `ipaddr.js` 检查 got 解析出的 `res.ip`，拒绝私有地址。
 * Workers 的 `fetch()` **不会暴露实际连接的 IP**，因此无法做等价的
 * 「连接后校验」。这里的防护策略是：
 *
 * 1. **字面量校验**：拒绝非 http(s) 协议、保留主机名（localhost/.internal/.local 等）
 *    以及字面量私有 IP（含 IPv4、IPv6、IPv4-mapped IPv6）；
 * 2. **网络层兜底**：Cloudflare 边缘本身无法路由到 RFC1918 / loopback / link-local
 *    地址，且在 `wrangler.toml` 中启用了 `global_fetch_strictly_public`
 *    兼容性标志，避免子请求绕过本 Zone 的安全策略。
 *
 * 注意：由于无法固定解析结果，理论上仍存在 DNS rebinding 的窗口；
 * 这是 Workers 运行时 API 的固有限制。若需要更强保证，可在正式环境前
 * 追加一层自建的 egress 代理。
 */

import ipaddr from 'ipaddr.js';
import { StatusError } from './status-error.js';

/**
 * 需要拒绝的「保留主机名」。
 *
 * 这些名称无法通过 CIDR 表达，因此在解析前直接拦截。
 */
const RESERVED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
const RESERVED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/** 判断主机名是否属于保留名称。 */
export function isReservedHostname(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	if (RESERVED_HOSTNAMES.has(lower)) return true;
	return RESERVED_HOSTNAME_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * 判断 IP 是否属于非公网地址。
 *
 * `ipaddr.js` 的 `range()` 对 IPv6 会返回 `unicast` / `private` / `loopback` /
 * `linkLocal` / `uniqueLocal` / `ipv4Mapped` / `6to4` / `teredo` 等。
 * 只要不是 `unicast` 就视为不可信（其中 IPv4-mapped 会先展开为 IPv4 再判断）。
 */
export function isPrivateAddress(ip: string): boolean {
	if (!ipaddr.isValid(ip)) {
		// 非法 IP：保守起见视为不可信。
		return true;
	}

	const addr = ipaddr.parse(ip);

	// IPv4-mapped IPv6（::ffff:a.b.c.d）先转换为 IPv4 再判断。
	if (addr.kind() === 'ipv6') {
		const v6 = addr as ipaddr.IPv6;
		if (v6.isIPv4MappedAddress()) {
			return isPrivateAddress(v6.toIPv4Address().toString());
		}
	}

	return addr.range() !== 'unicast';
}

/**
 * 判断 IP 是否匹配 `allowedPrivateNetworks` 中的任意 CIDR。
 *
 * 非法的 CIDR 会被忽略（与原版一致，不因为配置错误而放行）。
 */
export function matchesAllowedNetwork(ip: string, allowedPrivateNetworks: readonly string[]): boolean {
	if (allowedPrivateNetworks.length === 0) return false;
	if (!ipaddr.isValid(ip)) return false;

	const addr = ipaddr.parse(ip);
	for (const cidr of allowedPrivateNetworks) {
		try {
			const [range, bits] = ipaddr.parseCIDR(cidr);
			if (addr.kind() === range.kind() && addr.match([range, bits])) {
				return true;
			}
		} catch {
			// 忽略非法 CIDR。
		}
	}
	return false;
}

/**
 * 校验待代理的 URL 是否安全。
 *
 * @param raw 用户传入的原始 URL
 * @param allowedPrivateNetworks 允许访问的私有网段 CIDR 列表（默认空）
 * @returns 解析后的 URL 对象
 * @throws {StatusError} 400（URL 非法 / 协议不支持）或 403（命中私有地址）
 */
export function assertSafeUrl(raw: string, allowedPrivateNetworks: readonly string[] = []): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new StatusError('Invalid url', 400);
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new StatusError('Unsupported protocol', 400);
	}

	// `URL.hostname` 对 IPv6 会带上方括号（如 [::1]），这里去掉以便解析。
	const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
		? url.hostname.slice(1, -1)
		: url.hostname;

	if (isReservedHostname(hostname)) {
		throw new StatusError('Blocked address', 403, 'Blocked address');
	}

	if (ipaddr.isValid(hostname)) {
		const isPrivate = isPrivateAddress(hostname);
		const isAllowed = matchesAllowedNetwork(hostname, allowedPrivateNetworks);
		if (isPrivate && !isAllowed) {
			throw new StatusError('Blocked address', 403, 'Blocked address');
		}
	}

	return url;
}
