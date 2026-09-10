/**
 * `Content-Disposition` 的生成与解析。
 *
 * 原版依赖 npm 包 `content-disposition`。在 Worker 中只需要非常小的子集，
 * 因此这里内联实现，避免为几行逻辑引入依赖：
 * - `contentDisposition()`：生成 `inline; filename="..."; filename*=UTF-8''...`
 * - `parseFilename()`：从上游响应头中提取文件名
 * - `correctFilename()`：根据探测到的扩展名修正文件名
 *
 * 参考 RFC 6266 / RFC 5987。
 */

/** 对 RFC 5987 的 `ext-value` 进行百分号编码。 */
function encodeRfc5987(value: string): string {
	return encodeURIComponent(value).replace(/['()*]/g, (c) =>
		`%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/**
 * 生成 `Content-Disposition` 头。
 *
 * 同时输出 `filename`（ASCII 安全，作为旧客户端回退）与
 * `filename*`（UTF-8，保留原始非 ASCII 文件名），与原版一致。
 *
 * @param type `inline`（媒体代理始终使用 inline，避免触发下载）
 * @param filename 原始文件名
 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
	// 与 `content-disposition` 包相同：非 ASCII / 特殊字符替换为下划线作为回退名。
	const fallback = filename.replace(/[^\w.-]/g, '_');
	return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

/**
 * 从 `Content-Disposition` 响应头中提取文件名。
 *
 * 优先使用 `filename*`（RFC 5987，支持非 ASCII），其次使用 `filename`。
 * 解析失败时返回 `null`（调用方会退回使用 URL 的 basename）。
 */
export function parseFilename(header: string | null | undefined): string | null {
	if (!header) return null;

	// 1) filename*=UTF-8''... 或 charset''...
	const extended = /filename\*\s*=\s*([^;]+)/i.exec(header);
	if (extended) {
		const raw = extended[1]!.trim().replace(/^"|"$/g, '');
		const parts = raw.split("''");
		const encoded = parts.length > 1 ? parts.slice(1).join("''") : raw;
		try {
			return decodeURIComponent(encoded);
		} catch {
			return encoded;
		}
	}

	// 2) filename="..."（带引号，可能包含分号）
	const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
	if (quoted) {
		return quoted[1]!.replace(/\\(.)/g, '$1');
	}

	// 3) filename=token（无引号）
	const token = /filename\s*=\s*([^;]+)/i.exec(header);
	if (token) {
		return token[1]!.trim();
	}

	return null;
}

/**
 * 根据探测到的扩展名修正文件名。
 *
 * - 已有相同扩展名 → 原样返回；
 * - `jpg` 与 `.jpeg`、`tif` 与 `.tiff` 互相兼容；
 * - 其他情况追加扩展名；
 * - 扩展名未知（null）时追加 `.unknown`。
 *
 * 该实现与原版 `correctFilename` 完全一致。
 */
export function correctFilename(filename: string, ext: string | null): string {
	const dotExt = ext ? `.${ext}` : '.unknown';
	if (filename.endsWith(dotExt)) {
		return filename;
	}
	if (ext === 'jpg' && filename.endsWith('.jpeg')) {
		return filename;
	}
	if (ext === 'tif' && filename.endsWith('.tiff')) {
		return filename;
	}
	return `${filename}${dotExt}`;
}

/**
 * 从 URL 的 pathname 中取出安全的 basename。
 *
 * 仅用于「上游没有提供文件名」时的兜底，因此：
 * - 去掉查询串与 hash（`URL.pathname` 本身已不含）；
 * - 解码百分号编码；
 * - 空路径返回 `unknown`。
 */
export function filenameFromUrl(url: URL): string {
	const segments = url.pathname.split('/').filter((s) => s.length > 0);
	const last = segments.length > 0 ? segments[segments.length - 1]! : 'unknown';
	try {
		return decodeURIComponent(last);
	} catch {
		return last;
	}
}
