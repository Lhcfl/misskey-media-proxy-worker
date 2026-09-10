import { describe, expect, it } from 'vitest';
import {
	SVG_TRANSFORM_OPTIONS,
	buildTransformPlan,
	hasTransformQuery,
} from '../src/image-processor.js';

describe('hasTransformQuery', () => {
	it('无转换查询时为 false', () => {
		expect(hasTransformQuery(new URLSearchParams('url=https://example.com/a.png'))).toBe(false);
	});

	it('任意转换查询时为 true', () => {
		expect(hasTransformQuery(new URLSearchParams('url=x&emoji=1'))).toBe(true);
		expect(hasTransformQuery(new URLSearchParams('url=x&badge'))).toBe(true);
	});
});

describe('buildTransformPlan', () => {
	it('无转换查询返回 null（纯代理）', () => {
		expect(buildTransformPlan(new URLSearchParams('url=https://example.com/a.png'))).toBeNull();
	});

	it('emoji：高度 128、WebP、保留动画', () => {
		const plan = buildTransformPlan(new URLSearchParams('emoji=1'))!;
		expect(plan.kind).toBe('emoji');
		expect(plan.mime).toBe('image/webp');
		expect(plan.ext).toBe('webp');
		expect(plan.options).toMatchObject({
			height: 128,
			fit: 'scale-down',
			format: 'webp',
			anim: true,
		});
	});

	it('emoji + static：高度不变，但只取第一帧', () => {
		const plan = buildTransformPlan(new URLSearchParams('emoji=1&static=1'))!;
		expect(plan.options.height).toBe(128);
		expect(plan.options.anim).toBe(false);
	});

	it('avatar：高度 320、保留动画', () => {
		const plan = buildTransformPlan(new URLSearchParams('avatar=1'))!;
		expect(plan.kind).toBe('avatar');
		expect(plan.options).toMatchObject({ height: 320, anim: true });
	});

	it('static（单独）：498x422、静态 WebP', () => {
		const plan = buildTransformPlan(new URLSearchParams('static=1'))!;
		expect(plan.kind).toBe('static');
		expect(plan.options).toMatchObject({
			width: 498,
			height: 422,
			fit: 'scale-down',
			format: 'webp',
			anim: false,
		});
	});

	it('preview：200x200 静态 WebP', () => {
		const plan = buildTransformPlan(new URLSearchParams('preview=1'))!;
		expect(plan.kind).toBe('preview');
		expect(plan.options).toMatchObject({ width: 200, height: 200, format: 'webp', anim: false });
	});

	it('badge：96x96 PNG，fit=contain', () => {
		const plan = buildTransformPlan(new URLSearchParams('badge=1'))!;
		expect(plan.kind).toBe('badge');
		expect(plan.mime).toBe('image/png');
		expect(plan.ext).toBe('png');
		expect(plan.options).toMatchObject({ width: 96, height: 96, fit: 'contain', format: 'png' });
	});

	it('emoji 优先级高于 static（与原版分支顺序一致）', () => {
		const plan = buildTransformPlan(new URLSearchParams('static=1&emoji=1'))!;
		expect(plan.kind).toBe('emoji');
	});

	it('SVG 转换选项限制在 2048 内', () => {
		expect(SVG_TRANSFORM_OPTIONS).toMatchObject({ width: 2048, height: 2048, format: 'webp' });
	});
});
