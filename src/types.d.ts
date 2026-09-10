/**
 * Wrangler「Data」模块的类型声明。
 *
 * `wrangler.toml` 中通过：
 * ```toml
 * [[rules]]
 * type = "Data"
 * globs = ["**\/*.png"]
 * fallthrough = true
 * ```
 * 把 PNG 作为二进制数据模块打包，导入结果为 `ArrayBuffer`。
 *
 * 参考：https://developers.cloudflare.com/workers/wrangler/configuration/#bundling
 */
declare module '*.png' {
	const data: ArrayBuffer;
	export default data;
}
