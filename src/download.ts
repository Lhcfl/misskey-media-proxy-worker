/**
 * 远端下载与流式大小限制。
 *
 * 原版把响应写入临时文件（`tmp`），再用 `file-type` / sharp 读取该文件；
 * 需要处理 `content-length`、`downloadProgress`、超时、代理 Agent 等。
 *
 * Worker 版本完全去掉了文件系统与 got：
 * 1. `fetch()` 子请求（可选带上 `cf.image` 让 Cloudflare 直接返回转换结果）；
 * 2. 以 **流** 的方式读取响应体，只预先窥探头部 `PEEK_SIZE` 字节用于类型判定，
 *    并在后续读取过程中累加字节数、超过 `maxSize` 立即中断；
 * 3. 因此不会把大文件整体读入内存。
 */

import { PEEK_SIZE } from './const.js';
import { filenameFromUrl, parseFilename } from './content-disposition.js';
import type { ProxyConfig } from './config.js';
import type { ImageResizeOptions } from './image-processor.js';
import { assertSafeUrl } from './ssrf.js';
import { StatusError } from './status-error.js';

/** 一次下载的结果。 */
export interface DownloadResult {
	/** 经过校验的最终 URL（已跟随重定向）。 */
	url: URL;
	/** 上游响应对象（用于读取响应头）。 */
	response: Response;
	/** 响应体最前面的若干字节，用于类型探测。 */
	prefix: Uint8Array;
	/** 完整响应体（已附加大小限制），可直接作为 Response 的 body。 */
	stream: ReadableStream<Uint8Array>;
	/** 上游声明的 `Content-Length`（缺失时为 null）。 */
	contentLength: number | null;
	/** 推断出的文件名（优先上游 `Content-Disposition`，其次 URL basename）。 */
	filename: string;
}

/**
 * `RequestInit` 上的 `cf` 字段。
 *
 * `@cloudflare/workers-types` 已为 `RequestInit` 增加 `cf`，但本文件同时会被
 * Node（vitest）类型检查，为避免两套全局类型互相干扰，这里用结构化断言写入。
 */
type WithCfImage = { cf?: { image?: ImageResizeOptions } };

/** 将多个分片按上限合并为一个 `Uint8Array`（用于类型探测）。 */
function concatPrefix(chunks: readonly Uint8Array[], limit: number): Uint8Array {
	const total = Math.min(
		chunks.reduce((sum, c) => sum + c.byteLength, 0),
		limit,
	);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= total) break;
		const take = Math.min(chunk.byteLength, total - offset);
		out.set(chunk.subarray(0, take), offset);
		offset += take;
	}
	return out;
}

/**
 * 窥探响应体头部，并在后续读取中强制执行 `maxSize`。
 *
 * 返回：
 * - `prefix`：头 `PEEK_SIZE` 字节（用于 `detectType`）；
 * - `stream`：把已读分片与剩余分片重新拼接后的可读流，读取时会累加计数。
 */
async function peekAndLimit(
	body: ReadableStream<Uint8Array>,
	maxSize: number,
): Promise<{ prefix: Uint8Array; stream: ReadableStream<Uint8Array> }> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	// 阶段一：读取头部窗口。
	try {
		while (total < PEEK_SIZE) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				chunks.push(value);
				total += value.byteLength;
			}
		}
	} catch (err) {
		await reader.cancel().catch(() => {});
		throw err;
	}

	if (total > maxSize) {
		await reader.cancel().catch(() => {});
		throw new StatusError('maxSize exceeded', 413);
	}

	const prefix = concatPrefix(chunks, PEEK_SIZE);

	// 阶段二：把已读分片重新放出，并在继续读取时计数。
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
		},
		async pull(controller) {
			let read: ReadableStreamReadResult<Uint8Array>;
			try {
				read = await reader.read();
			} catch (err) {
				controller.error(err);
				return;
			}
			if (read.done) {
				controller.close();
				return;
			}
			total += read.value.byteLength;
			if (total > maxSize) {
				await reader.cancel().catch(() => {});
				controller.error(new StatusError('maxSize exceeded', 413));
				return;
			}
			controller.enqueue(read.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});

	return { prefix, stream };
}

/**
 * 下载远端资源。
 *
 * @param rawUrl 待代理的远端 URL
 * @param config 运行时配置
 * @param image 可选的 cf.image 转换选项；提供时由 Cloudflare 直接返回转换后的内容
 * @throws {StatusError} 400/403（URL 校验）、413（超出大小限制）、上游状态码等
 */
export async function downloadUrl(
	rawUrl: string,
	config: ProxyConfig,
	image?: ImageResizeOptions,
): Promise<DownloadResult> {
	const url = assertSafeUrl(rawUrl, config.allowedPrivateNetworks);

	const init: RequestInit = {
		method: 'GET',
		headers: {
			'User-Agent': config.userAgent,
			// 与原版 got 行为对齐：不依赖调用方的 Accept，统一接收任意类型。
			Accept: '*/*',
		},
		// 与原版 got 默认一致：跟随重定向（由运行时限制最大跳转次数）。
		redirect: 'follow',
	};
	if (image) {
		(init as WithCfImage).cf = { image };
	}

	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (err) {
		// 网络层错误（DNS 失败、TLS 错误、被拦截等）。
		throw new StatusError(`Upstream request failed: ${String(err)}`, 502);
	}

	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new StatusError(
			`${response.status} ${response.statusText}`.trim(),
			response.status,
			response.statusText,
		);
	}

	// 依据 `Content-Length` 提前拒绝超大响应。
	const contentLengthHeader = response.headers.get('content-length');
	const contentLength = contentLengthHeader != null ? Number(contentLengthHeader) : null;
	if (contentLength != null && Number.isFinite(contentLength) && contentLength > config.maxSize) {
		await response.body?.cancel().catch(() => {});
		throw new StatusError('maxSize exceeded', 413);
	}

	// 空响应体（极少见）时构造一个空流。
	if (!response.body) {
		return {
			url,
			response,
			prefix: new Uint8Array(0),
			stream: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			contentLength,
			filename: resolveFilename(response, url),
		};
	}

	const { prefix, stream } = await peekAndLimit(response.body, config.maxSize);

	return {
		url,
		response,
		prefix,
		stream,
		contentLength,
		filename: resolveFilename(response, url),
	};
}

/**
 * 解析文件名：优先上游 `Content-Disposition`，否则退回最终 URL 的 basename。
 */
function resolveFilename(response: Response, requestedUrl: URL): string {
	const fromHeader = parseFilename(response.headers.get('content-disposition'));
	if (fromHeader) return fromHeader;

	let finalUrl = requestedUrl;
	if (response.url) {
		try {
			finalUrl = new URL(response.url);
		} catch {
			// 保持使用请求 URL。
		}
	}
	return filenameFromUrl(finalUrl) || 'unknown';
}
