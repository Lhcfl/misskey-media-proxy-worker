/**
 * 图片转换计划。
 *
 * 原版使用 sharp.js 在临时文件上做实际的像素处理。Cloudflare Workers
 * 没有文件系统、也不能运行 sharp 的原生模块，因此这里改为使用
 * **Cloudflare Image Resizing**：在向源站发起子请求时通过
 * `fetch(url, { cf: { image: { ... } } })` 直接获得已转换的响应流，
 * 无需落盘、无需把图片读进内存。
 *
 * 本模块只负责「把媒体代理的转换查询翻译成 cf.image 选项」，
 * 保持纯函数，便于单元测试。
 */

import {
	AVATAR_HEIGHT,
	BADGE_SIZE,
	EMOJI_HEIGHT,
	PREVIEW_SIZE,
	STATIC_HEIGHT,
	STATIC_WIDTH,
	SVG_CONVERT_SIZE,
	WEBP_QUALITY,
} from './const.js';

/**
 * cf.image 支持的、本项目会用到的选项子集。
 *
 * 完整选项见：
 * https://developers.cloudflare.com/images/optimization/features/
 */
export interface ImageResizeOptions {
	/** 输出宽度（像素）。 */
	width?: number;
	/** 输出高度（像素）。 */
	height?: number;
	/**
	 * 尺寸适配方式：
	 * - `scale-down`（默认）：等比缩放到目标框内，**不放大**；
	 * - `contain`：等比缩放到目标框内，必要时放大。
	 */
	fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
	/** 输出格式。 */
	format?: 'webp' | 'png' | 'jpeg' | 'avif';
	/** 有损格式的质量（1-100）。 */
	quality?: number;
	/** 是否保留动画帧；`false` 表示只取第一帧。 */
	anim?: boolean;
}

/** 一次转换的完整计划。 */
export interface TransformPlan {
	/** 命中的转换种类。 */
	kind: 'emoji' | 'avatar' | 'static' | 'preview' | 'badge';
	/** 传给 cf.image 的选项。 */
	options: ImageResizeOptions;
	/** 输出的文件扩展名。 */
	ext: string;
	/** 输出的 MIME 类型。 */
	mime: string;
}

/**
 * 判断请求是否带有任意一种「转换查询」。
 *
 * 对应原版中对 `request.query` 的 `in` 判定。
 */
export function hasTransformQuery(query: URLSearchParams): boolean {
	return (
		query.has('emoji') ||
		query.has('avatar') ||
		query.has('static') ||
		query.has('preview') ||
		query.has('badge')
	);
}

/**
 * 根据查询参数构造转换计划。
 *
 * 分支顺序与原版 `proxyHandler` 完全一致：
 * `emoji`/`avatar` → `static` → `preview` → `badge`。
 *
 * @returns 命中转换时返回计划；否则返回 `null`（表示纯代理，不转换）。
 */
export function buildTransformPlan(query: URLSearchParams): TransformPlan | null {
	if (!hasTransformQuery(query)) return null;

	const isStatic = query.has('static');

	// emoji / avatar：限制高度并输出 WebP；`static` 只影响是否保留动画。
	if (query.has('emoji') || query.has('avatar')) {
		const height = query.has('emoji') ? EMOJI_HEIGHT : AVATAR_HEIGHT;
		return {
			kind: query.has('emoji') ? 'emoji' : 'avatar',
			options: {
				height,
				fit: 'scale-down',
				format: 'webp',
				quality: WEBP_QUALITY,
				anim: !isStatic,
			},
			ext: 'webp',
			mime: 'image/webp',
		};
	}

	// static：仅第一帧的静态 WebP，限制在 498x422 内。
	if (isStatic) {
		return {
			kind: 'static',
			options: {
				width: STATIC_WIDTH,
				height: STATIC_HEIGHT,
				fit: 'scale-down',
				format: 'webp',
				quality: WEBP_QUALITY,
				anim: false,
			},
			ext: 'webp',
			mime: 'image/webp',
		};
	}

	// preview：限制在 200x200 内的 WebP。
	if (query.has('preview')) {
		return {
			kind: 'preview',
			options: {
				width: PREVIEW_SIZE,
				height: PREVIEW_SIZE,
				fit: 'scale-down',
				format: 'webp',
				quality: WEBP_QUALITY,
				anim: false,
			},
			ext: 'webp',
			mime: 'image/webp',
		};
	}

	// badge：96x96 的 PNG，用于 Web Push 通知徽章。
	//
	// 说明：原版会用 sharp 做「灰度 + 对比度 + 只保留 alpha 通道」的处理，
	// 产出单色蒙版。cf.image 不提供灰度/通道运算，因此这里只能近似为
	// 96x96 的 PNG（保持原色）。详见 README 的「已知差异」。
	return {
		kind: 'badge',
		options: {
			width: BADGE_SIZE,
			height: BADGE_SIZE,
			fit: 'contain',
			format: 'png',
		},
		ext: 'png',
		mime: 'image/png',
	};
}

/**
 * 纯代理模式下遇到 SVG 时使用的转换选项。
 *
 * 与原版一致：SVG 不允许原样返回（XSS 风险），统一转成最大 2048x2048 的 WebP。
 */
export const SVG_TRANSFORM_OPTIONS: ImageResizeOptions = {
	width: SVG_CONVERT_SIZE,
	height: SVG_CONVERT_SIZE,
	fit: 'scale-down',
	format: 'webp',
	quality: WEBP_QUALITY,
};
