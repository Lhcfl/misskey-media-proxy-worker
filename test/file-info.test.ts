import { describe, expect, it } from 'vitest';
import { detectType, isMimeImage } from '../src/file-info.js';

/** 构造字节数组。 */
const bytes = (...values: number[]) => new Uint8Array(values);

/** 构造 ASCII 字节数组。 */
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

/** 拼接多个字节数组。 */
const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.byteLength;
	}
	return out;
};

/** 构造一个 ISO BMFF（ftyp）头。 */
const ftyp = (brand: string) => concat(bytes(0, 0, 0, 0x18), ascii('ftyp'), ascii(brand));

describe('detectType', () => {
	it('识别 PNG', () => {
		expect(detectType(concat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), bytes(0, 0))).mime).toBe('image/png');
	});

	it('识别 APNG（PNG 中带 acTL 块）', () => {
		const png = concat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), ascii('acTL'), bytes(1, 2, 3));
		expect(detectType(png)).toEqual({ mime: 'image/apng', ext: 'apng' });
	});

	it('识别 JPEG', () => {
		expect(detectType(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00))).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
	});

	it('识别 GIF', () => {
		expect(detectType(ascii('GIF89a...'))).toEqual({ mime: 'image/gif', ext: 'gif' });
	});

	it('识别 WebP（RIFF/WEBP）', () => {
		const webp = concat(ascii('RIFF'), bytes(0, 0, 0, 0), ascii('WEBP'));
		expect(detectType(webp)).toEqual({ mime: 'image/webp', ext: 'webp' });
	});

	it('识别 AVIF（ftyp avif）', () => {
		expect(detectType(ftyp('avif'))).toEqual({ mime: 'image/avif', ext: 'avif' });
	});

	it('识别 MP4（ftyp isom）', () => {
		expect(detectType(ftyp('isom'))).toEqual({ mime: 'video/mp4', ext: 'mp4' });
	});

	it('识别 QuickTime（ftyp qt  ）', () => {
		expect(detectType(ftyp('qt  '))).toEqual({ mime: 'video/quicktime', ext: 'mov' });
	});

	it('未知 ftyp brand 落为 octet-stream', () => {
		expect(detectType(ftyp('zzzz')).mime).toBe('application/octet-stream');
	});

	it('识别 Ogg Opus', () => {
		const ogg = concat(ascii('OggS'), bytes(0, 0), ascii('OpusHead'));
		expect(detectType(ogg)).toEqual({ mime: 'audio/opus', ext: 'opus' });
	});

	it('识别 WebM（EBML + webm）', () => {
		const webm = concat(bytes(0x1a, 0x45, 0xdf, 0xa3), ascii('webm'));
		expect(detectType(webm)).toEqual({ mime: 'video/webm', ext: 'webm' });
	});

	it('matroska 不在白名单，落为 octet-stream', () => {
		const mkv = concat(bytes(0x1a, 0x45, 0xdf, 0xa3), ascii('matroska'));
		expect(detectType(mkv).mime).toBe('application/octet-stream');
	});

	it('识别 FLAC', () => {
		expect(detectType(ascii('fLaC....'))).toEqual({ mime: 'audio/flac', ext: 'flac' });
	});

	it('识别 WAV（RIFF/WAVE）', () => {
		const wav = concat(ascii('RIFF'), bytes(0, 0, 0, 0), ascii('WAVE'));
		expect(detectType(wav)).toEqual({ mime: 'audio/wav', ext: 'wav' });
	});

	it('识别 MP3（ID3）', () => {
		expect(detectType(ascii('ID3\x04')).mime).toBe('audio/mpeg');
	});

	it('识别 SVG', () => {
		expect(detectType(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toEqual({
			mime: 'image/svg+xml',
			ext: 'svg',
		});
	});

	it('识别带 XML 声明的 SVG', () => {
		expect(detectType(ascii('<?xml version="1.0"?>\n<svg></svg>')).mime).toBe('image/svg+xml');
	});

	it('空文件为 octet-stream', () => {
		expect(detectType(new Uint8Array(0)).mime).toBe('application/octet-stream');
	});

	it('随机内容为 octet-stream', () => {
		expect(detectType(ascii('hello world')).mime).toBe('application/octet-stream');
	});
});

describe('isMimeImage', () => {
	it('safe-file 命中白名单', () => {
		expect(isMimeImage('image/png', 'safe-file')).toBe(true);
		expect(isMimeImage('application/pdf', 'safe-file')).toBe(false);
	});

	it('sharp-convertible-image 排除 gif 之外的非图片', () => {
		expect(isMimeImage('image/gif', 'sharp-convertible-image')).toBe(true);
		expect(isMimeImage('video/mp4', 'sharp-convertible-image')).toBe(false);
	});
});
