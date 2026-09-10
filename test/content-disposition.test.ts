import { describe, expect, it } from 'vitest';
import {
	contentDisposition,
	correctFilename,
	filenameFromUrl,
	parseFilename,
} from '../src/content-disposition.js';

describe('contentDisposition', () => {
	it('生成 inline + ASCII 回退名 + UTF-8 文件名', () => {
		const header = contentDisposition('inline', 'image.png');
		expect(header).toBe(`inline; filename="image.png"; filename*=UTF-8''image.png`);
	});

	it('非 ASCII 文件名在回退名中被替换', () => {
		const header = contentDisposition('inline', '猫.png');
		expect(header).toContain('filename="_.png"');
		expect(header).toContain(`filename*=UTF-8''%E7%8C%AB.png`);
	});

	it('转义 RFC 5987 特殊字符', () => {
		const header = contentDisposition('inline', "a'b(c)d*e.png");
		expect(header).toContain("filename*=UTF-8''a%27b%28c%29d%2Ae.png");
	});
});

describe('parseFilename', () => {
	it('解析带引号的 filename', () => {
		expect(parseFilename('attachment; filename="photo.jpg"')).toBe('photo.jpg');
	});

	it('解析无引号的 filename', () => {
		expect(parseFilename('attachment; filename=photo.jpg')).toBe('photo.jpg');
	});

	it('优先解析 filename* 并解码', () => {
		expect(parseFilename(`inline; filename="_.png"; filename*=UTF-8''%E7%8C%AB.png`)).toBe('猫.png');
	});

	it('无 filename 时返回 null', () => {
		expect(parseFilename('inline')).toBeNull();
		expect(parseFilename(null)).toBeNull();
	});
});

describe('correctFilename', () => {
	it('已有相同扩展名则不变', () => {
		expect(correctFilename('image.png', 'png')).toBe('image.png');
	});

	it('追加扩展名', () => {
		expect(correctFilename('image', 'png')).toBe('image.png');
	});

	it('jpeg 与 jpg 互认', () => {
		expect(correctFilename('image.jpeg', 'jpg')).toBe('image.jpeg');
	});

	it('tiff 与 tif 互认', () => {
		expect(correctFilename('image.tiff', 'tif')).toBe('image.tiff');
	});

	it('未知扩展名追加 .unknown', () => {
		expect(correctFilename('image', null)).toBe('image.unknown');
	});
});

describe('filenameFromUrl', () => {
	it('取 pathname 的 basename', () => {
		expect(filenameFromUrl(new URL('https://example.com/a/b/photo.png?x=1'))).toBe('photo.png');
	});

	it('解码百分号编码', () => {
		expect(filenameFromUrl(new URL('https://example.com/%E7%8C%AB.png'))).toBe('猫.png');
	});

	it('无路径时返回 unknown', () => {
		expect(filenameFromUrl(new URL('https://example.com/'))).toBe('unknown');
	});
});
