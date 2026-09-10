/**
 * 运行时配置。
 *
 * 原版通过 `config.js` + 环境变量注入配置。Workers 版本的等价物是
 * `wrangler.toml` 的 `[vars]` / 密钥绑定，在每次请求时通过 `env` 读取。
 * 这里把它解析成具名的 `ProxyConfig`，其余模块只依赖该结构。
 */

import {
	DEFAULT_CSP,
	DEFAULT_MAX_SIZE,
	DEFAULT_USER_AGENT,
} from './const.js';

/** Worker 环境绑定的形状（对应 wrangler.toml 的 `[vars]`）。 */
export interface Env {
	/** 请求远端时使用的 User-Agent。默认 `MisskeyMediaProxyWorker/<version>`。 */
	USER_AGENT?: string;
	/** 允许访问的私有网段 CIDR，逗号分隔（例如 `10.0.0.0/8,192.168.0.0/16`）。 */
	ALLOWED_PRIVATE_NETWORKS?: string;
	/** 单个文件最大字节数。默认 262144000（250 MiB）。 */
	MAX_SIZE?: string;
	/** CORS `Access-Control-Allow-Origin`。默认 `*`。 */
	CORS_ALLOW_ORIGIN?: string;
	/** CORS `Access-Control-Allow-Headers`。默认 `*`。 */
	CORS_ALLOW_HEADERS?: string;
	/** 返回的 `Content-Security-Policy`。 */
	CONTENT_SECURITY_POLICY?: string;
	/** 是否启用图片转换（cf.image）。默认 `true`；设为 `false` 时转换请求返回 501。 */
	ENABLE_IMAGE_RESIZING?: string;
}

/** 解析后的、可直接使用的配置。 */
export interface ProxyConfig {
	/** 请求远端时使用的 User-Agent。 */
	userAgent: string;
	/** 允许访问的私有网段 CIDR。 */
	allowedPrivateNetworks: string[];
	/** 单个文件最大字节数。 */
	maxSize: number;
	/** CORS 允许的源。 */
	corsOrigin: string;
	/** CORS 允许的请求头。 */
	corsHeaders: string;
	/** Content-Security-Policy。 */
	csp: string;
	/** 是否启用 cf.image 转换。 */
	enableImageResizing: boolean;
}

/**
 * 解析逗号分隔的 CIDR 列表，忽略空白与空项。
 *
 * 例：`"10.0.0.0/8, 192.168.0.0/16"` → `["10.0.0.0/8", "192.168.0.0/16"]`
 */
function parseNetworkList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * 解析 `MAX_SIZE`。
 *
 * 非法或非正数时回退到默认值，避免因为配置错误而完全放开或拒绝所有请求。
 */
function parseMaxSize(value: string | undefined): number {
	if (!value) return DEFAULT_MAX_SIZE;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_SIZE;
	return Math.floor(parsed);
}

/**
 * 从环境绑定构造配置对象。
 *
 * 该函数是幂等且无副作用的，便于测试。
 */
export function loadConfig(env: Env): ProxyConfig {
	return {
		userAgent: env.USER_AGENT?.trim() || DEFAULT_USER_AGENT,
		allowedPrivateNetworks: parseNetworkList(env.ALLOWED_PRIVATE_NETWORKS),
		maxSize: parseMaxSize(env.MAX_SIZE),
		corsOrigin: env.CORS_ALLOW_ORIGIN ?? '*',
		corsHeaders: env.CORS_ALLOW_HEADERS ?? '*',
		csp: env.CONTENT_SECURITY_POLICY ?? DEFAULT_CSP,
		enableImageResizing: env.ENABLE_IMAGE_RESIZING !== 'false',
	};
}
