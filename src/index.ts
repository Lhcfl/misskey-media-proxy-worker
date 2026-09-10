/**
 * Cloudflare Worker 入口。
 *
 * 这是原版 `misskey-media-proxy`（基于 Fastify + sharp + 临时文件）的重构实现，
 * 目标是在 Cloudflare Workers 上提供完全等价、但无状态、无文件系统的媒体代理：
 *
 * - **纯代理**：把远端图片/音视频原样转发一次，并附加安全响应头；
 * - **图片转换**：`emoji` / `avatar` / `static` / `preview` / `badge`
 *   由 Cloudflare Image Resizing（`cf.image`）完成；
 * - **安全**：SVG 不原样返回、Content-Type 由魔数探测决定、SSRF 校验、
 *   CSP 与 `X-Content-Type-Options: nosniff`。
 *
 * 与原版的差异与已知限制见 README。
 */

import dummyPng from '../assets/dummy.png';
import {
	CACHE_CONTROL_ERROR,
	CACHE_CONTROL_SUCCESS,
	FILE_TYPE_BROWSERSAFE,
} from './const.js';
import { contentDisposition, correctFilename } from './content-disposition.js';
import type { Env, ProxyConfig } from './config.js';
import { loadConfig } from './config.js';
import type { DownloadResult } from './download.js';
import { downloadUrl } from './download.js';
import { detectType } from './file-info.js';
import type { TransformPlan } from './image-processor.js';
import { SVG_TRANSFORM_OPTIONS, buildTransformPlan } from './image-processor.js';
import { StatusError } from './status-error.js';

export default {
	/**
	 * Worker 的 fetch 处理器。
	 *
	 * @param request 传入请求
	 * @param env     `wrangler.toml` 中 `[vars]` 提供的配置
	 */
	async fetch(request: Request, env: Env): Promise<Response> {
		const config = loadConfig(env);

		// CORS 预检：直接返回 204。
		if (request.method === 'OPTIONS') {
			return withCommonHeaders(new Response(null, { status: 204 }), config);
		}

		// 与原版 Fastify 路由一致：只允许 GET（以及语义等价的 HEAD）。
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return withCommonHeaders(
				new Response(null, { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } }),
				config,
			);
		}

		try {
			let response = await handleProxy(request, config);

			// HEAD：执行完完整逻辑后丢弃响应体，只保留响应头。
			if (request.method === 'HEAD') {
				await response.body?.cancel().catch(() => {});
				response = new Response(null, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			}

			return withCommonHeaders(response, config);
		} catch (err) {
			return withCommonHeaders(await errorResponse(request, err, config), config);
		}
	},
};

/**
 * 核心代理流程：解析源 URL、选择「纯代理」或「转换」分支。
 */
async function handleProxy(request: Request, config: ProxyConfig): Promise<Response> {
	const requestUrl = new URL(request.url);
	const sourceUrl = resolveSourceUrl(requestUrl);

	if (!sourceUrl) {
		throw new StatusError('Missing url', 400);
	}

	const plan = buildTransformPlan(requestUrl.searchParams);
	if (plan) {
		if (!config.enableImageResizing) {
			throw new StatusError('Image resizing is disabled', 501);
		}
		return handleTransform(sourceUrl, plan, config);
	}

	return handlePlain(sourceUrl, config);
}

/**
 * 解析待代理的源 URL。
 *
 * 兼容两种调用形式（与原版一致）：
 * 1. 查询参数：`/proxy/image.webp?url=https%3A%2F%2F...`
 * 2. 通配路径：`/example.com/path/to/image.png` → `https://example.com/path/to/image.png`
 *
 * @returns 源 URL 字符串；无法解析时返回 `null`
 */
function resolveSourceUrl(requestUrl: URL): string | null {
	// 注意：用 `has` 而不是 `get`，以便 `?url=`（空值）也能按原版返回 400。
	if (requestUrl.searchParams.has('url')) {
		return requestUrl.searchParams.get('url') ?? '';
	}

	const path = requestUrl.pathname.replace(/^\/+/, '');
	if (!path) return null;

	return `https://${path}`;
}

/**
 * 纯代理分支：不转换（SVG 除外），原样转发内容。
 *
 * 与原版相同：
 * - 未指定转换查询时，只允许「图片」或白名单内的其它文件；
 * - SVG 属于 XSS 风险类型，会被强制转为 WebP（最大 2048x2048）。
 */
async function handlePlain(sourceUrl: string, config: ProxyConfig): Promise<Response> {
	let download = await downloadUrl(sourceUrl, config);
	const detected = detectType(download.prefix);

	let mime = detected.mime;
	let ext = detected.ext;

	if (mime === 'image/svg+xml') {
		// 丢弃原始 SVG 响应体，改用 cf.image 转换后再返回。
		await download.stream.cancel().catch(() => {});
		if (!config.enableImageResizing) {
			throw new StatusError('Rejected type', 403, 'Rejected type');
		}
		download = await downloadUrl(sourceUrl, config, SVG_TRANSFORM_OPTIONS);
		mime = 'image/webp';
		ext = 'webp';
	} else if (!(mime.startsWith('image/') || FILE_TYPE_BROWSERSAFE.includes(mime))) {
		await download.stream.cancel().catch(() => {});
		throw new StatusError('Rejected type', 403, 'Rejected type');
	}

	return buildMediaResponse(download, mime, ext);
}

/**
 * 转换分支：把转换计划交给 Cloudflare Image Resizing。
 *
 * @throws {StatusError} 404：源内容无法转换（cf.image 返回 4xx，
 *   或输出并非图片），对应原版「有转换查询但源不是图片」的 404。
 */
async function handleTransform(
	sourceUrl: string,
	plan: TransformPlan,
	config: ProxyConfig,
): Promise<Response> {
	let download: DownloadResult;
	try {
		download = await downloadUrl(sourceUrl, config, plan.options);
	} catch (err) {
		if (err instanceof StatusError && err.isClientError) {
			throw new StatusError('Unexpected mime', 404);
		}
		throw err;
	}

	// 双重保险：确认 cf.image 确实产出了图片，避免把原始非图片内容透传出去。
	const contentType = (download.response.headers.get('content-type') ?? '')
		.split(';')[0]!
		.trim()
		.toLowerCase();
	if (!contentType.startsWith('image/')) {
		await download.stream.cancel().catch(() => {});
		throw new StatusError('Unexpected mime', 404);
	}

	return buildMediaResponse(download, plan.mime, plan.ext);
}

/**
 * 由下载结果构造媒体响应，统一设置内容类型、缓存、文件名等。
 */
function buildMediaResponse(
	download: DownloadResult,
	mime: string,
	ext: string | null,
): Response {
	const headers = new Headers();
	headers.set('Content-Type', mime);
	headers.set('Cache-Control', CACHE_CONTROL_SUCCESS);
	headers.set('Content-Disposition', contentDisposition('inline', correctFilename(download.filename, ext)));
	if (download.contentLength != null) {
		headers.set('Content-Length', String(download.contentLength));
	}
	return new Response(download.stream, { status: 200, headers });
}

/**
 * 错误响应。
 *
 * 与原版 `errorHandler` 对齐：
 * - 始终附带 `Cache-Control: max-age=300`；
 * - 若查询串含 `fallback`，返回占位图 `dummy.png`（HTTP 200）；
 * - 否则 4xx 原样返回，其他一律 500。
 *
 * 注意：错误响应同样会经过 `withCommonHeaders`，因此仍带有 CORS / CSP。
 */
async function errorResponse(
	request: Request,
	err: unknown,
	config: ProxyConfig,
): Promise<Response> {
	console.error(err);

	const headers = new Headers();
	headers.set('Cache-Control', CACHE_CONTROL_ERROR);

	const hasFallback = new URL(request.url).searchParams.has('fallback');
	if (hasFallback) {
		headers.set('Content-Type', 'image/png');
		headers.set('Content-Length', String(dummyPng.byteLength));
		headers.set('Content-Disposition', contentDisposition('inline', 'dummy.png'));
		return new Response(dummyPng, { status: 200, headers });
	}

	let status = 500;
	if (err instanceof StatusError && (err.statusCode === 302 || err.isClientError)) {
		status = err.statusCode;
	}

	return new Response(null, { status, headers });
}

/**
 * 为所有响应统一附加 CORS / CSP 等公共响应头。
 *
 * 相比原版额外加入 `X-Content-Type-Options: nosniff`，
 * 进一步降低浏览器基于内容嗅探执行脚本的风险。
 */
function withCommonHeaders(response: Response, config: ProxyConfig): Response {
	const headers = new Headers(response.headers);
	headers.set('Access-Control-Allow-Origin', config.corsOrigin);
	headers.set('Access-Control-Allow-Headers', config.corsHeaders);
	headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
	headers.set('Content-Security-Policy', config.csp);
	headers.set('X-Content-Type-Options', 'nosniff');

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
