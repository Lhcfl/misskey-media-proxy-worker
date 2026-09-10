/**
 * 文件类型探测（magic bytes）。
 *
 * 原版依赖 npm 包 `file-type`（读取临时文件）与 `is-svg`（读取整个文件）。
 * Workers 没有文件系统，因此这里改为**对已读取的头部字节做纯函数式探测**，
 * 既不落盘、也不把整个文件读进内存。
 *
 * 支持的范围与原版 `FILE_TYPE_BROWSERSAFE` 对齐，并额外识别 SVG。
 * 无法识别的类型统一返回 `application/octet-stream`。
 */

import { FILE_TYPE_BROWSERSAFE, SHARP_ANIMATION_CONVERTIBLE_IMAGE, SHARP_CONVERTIBLE_IMAGE } from './const.js';

/** 探测结果：MIME 类型与建议的文件扩展名（未知时为 null）。 */
export interface FileType {
	mime: string;
	ext: string | null;
}

/** 未知类型的统一表示。 */
const TYPE_OCTET_STREAM: FileType = { mime: 'application/octet-stream', ext: null };

/** SVG 的表示。 */
const TYPE_SVG: FileType = { mime: 'image/svg+xml', ext: 'svg' };

/** 判断 `bytes` 在 `offset` 处是否与 ASCII 字符串 `str` 相等。 */
function matchAscii(bytes: Uint8Array, str: string, offset = 0): boolean {
	if (offset + str.length > bytes.byteLength) return false;
	for (let i = 0; i < str.length; i++) {
		if (bytes[offset + i] !== str.charCodeAt(i)) return false;
	}
	return true;
}

/** 判断 `bytes` 在 `offset` 处是否与给定的字节序列相等。 */
function matchBytes(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
	if (offset + sig.length > bytes.byteLength) return false;
	for (let i = 0; i < sig.length; i++) {
		if (bytes[offset + i] !== sig[i]) return false;
	}
	return true;
}

/** 在 `haystack[0..limit)` 中查找 ASCII 子串，返回下标或 -1。 */
function indexOfAscii(haystack: Uint8Array, needle: string, limit?: number): number {
	const end = Math.min(haystack.byteLength, limit ?? haystack.byteLength);
	const first = needle.charCodeAt(0);
	for (let i = 0; i <= end - needle.length; i++) {
		if (haystack[i] !== first) continue;
		let ok = true;
		for (let j = 1; j < needle.length; j++) {
			if (haystack[i + j] !== needle.charCodeAt(j)) {
				ok = false;
				break;
			}
		}
		if (ok) return i;
	}
	return -1;
}

/**
 * ISO/IEC base media file format (`ftyp`) 的 brand → 类型映射。
 *
 * 只覆盖与原版白名单相关的类型；未知 brand 会被当作 octet-stream，
 * 与原版 `file-type` 的行为保持一致（宁可拒绝，也不臆测类型）。
 */
const FTYP_BRANDS: Record<string, FileType> = {
	// AVIF
	avif: { mime: 'image/avif', ext: 'avif' },
	avis: { mime: 'image/avif', ext: 'avif' },

	// QuickTime
	'qt  ': { mime: 'video/quicktime', ext: 'mov' },

	// MP4 家族
	isom: { mime: 'video/mp4', ext: 'mp4' },
	iso2: { mime: 'video/mp4', ext: 'mp4' },
	iso3: { mime: 'video/mp4', ext: 'mp4' },
	iso4: { mime: 'video/mp4', ext: 'mp4' },
	iso5: { mime: 'video/mp4', ext: 'mp4' },
	iso6: { mime: 'video/mp4', ext: 'mp4' },
	mp41: { mime: 'video/mp4', ext: 'mp4' },
	mp42: { mime: 'video/mp4', ext: 'mp4' },
	mp4v: { mime: 'video/mp4', ext: 'mp4' },
	mp71: { mime: 'video/mp4', ext: 'mp4' },
	mmp4: { mime: 'video/mp4', ext: 'mp4' },
	avc1: { mime: 'video/mp4', ext: 'mp4' },
	dash: { mime: 'video/mp4', ext: 'mp4' },
	F4V: { mime: 'video/mp4', ext: 'mp4' },
	F4P: { mime: 'video/mp4', ext: 'mp4' },

	// M4V
	'M4V ': { mime: 'video/x-m4v', ext: 'm4v' },
	M4VH: { mime: 'video/x-m4v', ext: 'm4v' },
	M4VP: { mime: 'video/x-m4v', ext: 'm4v' },

	// 音频
	'M4A ': { mime: 'audio/x-m4a', ext: 'm4a' },
	M4B: { mime: 'audio/mp4', ext: 'm4b' },
	'M4B ': { mime: 'audio/mp4', ext: 'm4b' },
	'M4P ': { mime: 'audio/mp4', ext: 'm4p' },
	mp4a: { mime: 'audio/mp4', ext: 'm4a' },
	F4A: { mime: 'audio/mp4', ext: 'm4a' },
	F4B: { mime: 'audio/mp4', ext: 'm4a' },

	// 3GPP / 3GPP2
	'3gp4': { mime: 'video/3gpp', ext: '3gp' },
	'3gp5': { mime: 'video/3gpp', ext: '3gp' },
	'3gp6': { mime: 'video/3gpp', ext: '3gp' },
	'3gp7': { mime: 'video/3gpp', ext: '3gp' },
	'3g2a': { mime: 'video/3gpp2', ext: '3g2' },
	'3g2b': { mime: 'video/3gpp2', ext: '3g2' },
	'3g2c': { mime: 'video/3gpp2', ext: '3g2' },
};

/** PNG 魔数：\x89PNG\r\n\x1a\n。 */
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 二进制魔数探测（不含 SVG 等文本格式）。
 *
 * @returns 命中的类型；无法识别时返回 `null`。
 */
function detectBinaryType(bytes: Uint8Array): FileType | null {
	// --- 图片 -----------------------------------------------------------------
	// PNG  / APNG
	if (matchBytes(bytes, PNG_SIG)) {
		// APNG 本质是带 `acTL` 块的 PNG，且该块必须出现在第一个 `IDAT` 之前。
		// 在头部窗口内查找 `acTL` 即可判定。
		if (indexOfAscii(bytes, 'acTL', 1024) !== -1) {
			return { mime: 'image/apng', ext: 'apng' };
		}
		return { mime: 'image/png', ext: 'png' };
	}

	// JPEG：FF D8 FF
	if (matchBytes(bytes, [0xff, 0xd8, 0xff])) {
		return { mime: 'image/jpeg', ext: 'jpg' };
	}

	// GIF：GIF87a / GIF89a
	if (matchAscii(bytes, 'GIF87a') || matchAscii(bytes, 'GIF89a')) {
		return { mime: 'image/gif', ext: 'gif' };
	}

	// WebP：RIFF....WEBP
	if (matchAscii(bytes, 'RIFF') && matchAscii(bytes, 'WEBP', 8)) {
		return { mime: 'image/webp', ext: 'webp' };
	}

	// BMP：BM
	if (matchAscii(bytes, 'BM')) {
		return { mime: 'image/bmp', ext: 'bmp' };
	}

	// TIFF：II*\0（小端）或 MM\0*（大端）
	if (matchBytes(bytes, [0x49, 0x49, 0x2a, 0x00]) || matchBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
		return { mime: 'image/tiff', ext: 'tif' };
	}

	// ICO：00 00 01 00
	if (matchBytes(bytes, [0x00, 0x00, 0x01, 0x00])) {
		return { mime: 'image/x-icon', ext: 'ico' };
	}

	// --- ISO BMFF（MP4 / MOV / AVIF / M4A / 3GP ...）--------------------------
	// 结构：[4 字节 size]["ftyp"][4 字节 major brand]
	if (matchAscii(bytes, 'ftyp', 4)) {
		const brand = String.fromCharCode(
			bytes[8] ?? 0x20,
			bytes[9] ?? 0x20,
			bytes[10] ?? 0x20,
			bytes[11] ?? 0x20,
		);
		const type = FTYP_BRANDS[brand];
		if (type) return type;
		// 未知 brand：按 file-type 的行为返回 null，最终落为 octet-stream。
		return null;
	}

	// --- OggS 容器 ------------------------------------------------------------
	if (matchAscii(bytes, 'OggS')) {
		// 编解码器标识位于第一个 page header 之后，这里在头部窗口内搜索即可。
		if (indexOfAscii(bytes, 'OpusHead', 256) !== -1) return { mime: 'audio/opus', ext: 'opus' };
		if (indexOfAscii(bytes, '\x01vorbis', 256) !== -1) return { mime: 'audio/ogg', ext: 'ogg' };
		if (indexOfAscii(bytes, 'theora', 256) !== -1) return { mime: 'video/ogg', ext: 'ogv' };
		return { mime: 'application/ogg', ext: 'ogg' };
	}

	// --- Matroska / WebM（EBML）----------------------------------------------
	if (matchBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
		// DocType 字符串位于 EBML 头部，搜索 `webm` 以限制到白名单内的类型。
		if (indexOfAscii(bytes, 'webm', 256) !== -1) return { mime: 'video/webm', ext: 'webm' };
		// matroska 不在浏览器安全白名单内，返回 null → octet-stream。
		return null;
	}

	// --- 音频 -----------------------------------------------------------------
	// FLAC：fLaC
	if (matchAscii(bytes, 'fLaC')) {
		return { mime: 'audio/flac', ext: 'flac' };
	}

	// WAV：RIFF....WAVE
	if (matchAscii(bytes, 'RIFF') && matchAscii(bytes, 'WAVE', 8)) {
		return { mime: 'audio/wav', ext: 'wav' };
	}

	// MP3：ID3 标签，或 MPEG 音频帧同步（11 个 1 位：FF Ex）。
	if (matchAscii(bytes, 'ID3')) {
		return { mime: 'audio/mpeg', ext: 'mp3' };
	}
	if (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
		return { mime: 'audio/mpeg', ext: 'mp3' };
	}

	// AAC（ADTS）：FF F1 / FF F9
	if (matchBytes(bytes, [0xff, 0xf1]) || matchBytes(bytes, [0xff, 0xf9])) {
		return { mime: 'audio/aac', ext: 'aac' };
	}

	// --- 视频 -----------------------------------------------------------------
	// MPEG-PS / MPEG-Video：00 00 01 BA / B3
	if (matchBytes(bytes, [0x00, 0x00, 0x01, 0xba]) || matchBytes(bytes, [0x00, 0x00, 0x01, 0xb3])) {
		return { mime: 'video/mpeg', ext: 'mpeg' };
	}

	return null;
}

/**
 * 判定字节内容是否为 SVG。
 *
 * 相比原版 `is-svg`（完整 HTML 解析），这里只检查文档开头：
 * 一份合法 SVG 的根元素必须是 `<svg>`，只会被 XML 声明、注释、DOCTYPE
 * 等少量 prolog 内容前置。因此 4KB 的头部窗口足以判定。
 */
function checkSvg(bytes: Uint8Array): boolean {
	if (bytes.byteLength === 0) return false;
	const head = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
	return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?<svg[\s/>]/i.test(head);
}

/**
 * 从文件头字节探测类型。
 *
 * 行为与原版 `detectType` 对齐：
 * 1. 空文件 → `application/octet-stream`；
 * 2. 二进制魔数命中且属于浏览器安全类型 → 返回该类型；
 * 3. 命中但不在白名单 → `application/octet-stream`；
 * 4. 文本且疑似 SVG → `image/svg+xml`；
 * 5. 其余 → `application/octet-stream`。
 */
export function detectType(bytes: Uint8Array): FileType {
	if (bytes.byteLength === 0) return TYPE_OCTET_STREAM;

	const type = detectBinaryType(bytes);
	if (type) {
		if (!isMimeImage(type.mime, 'safe-file')) {
			return TYPE_OCTET_STREAM;
		}
		return { mime: fixMime(type.mime), ext: type.ext };
	}

	if (checkSvg(bytes)) return TYPE_SVG;

	return TYPE_OCTET_STREAM;
}

/**
 * 判断 MIME 是否属于指定的图片集合。
 *
 * @param mime 待判定 MIME
 * @param kind `safe-file` | `sharp-convertible-image` | `sharp-animation-convertible-image`
 */
export function isMimeImage(
	mime: string,
	kind: 'safe-file' | 'sharp-convertible-image' | 'sharp-animation-convertible-image',
): boolean {
	switch (kind) {
		case 'safe-file':
			return FILE_TYPE_BROWSERSAFE.includes(mime);
		case 'sharp-convertible-image':
			return SHARP_CONVERTIBLE_IMAGE.includes(mime);
		case 'sharp-animation-convertible-image':
			return SHARP_ANIMATION_CONVERTIBLE_IMAGE.includes(mime);
	}
}

/**
 * 归一化 file-type 返回的历史 MIME。
 *
 * 见 https://github.com/misskey-dev/misskey/pull/10686
 */
export function fixMime(mime: string): string {
	if (mime === 'audio/x-flac') return 'audio/flac';
	if (mime === 'audio/vnd.wave') return 'audio/wav';
	return mime;
}
