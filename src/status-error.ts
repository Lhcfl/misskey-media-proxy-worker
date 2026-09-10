/**
 * 携带 HTTP 状态码的错误类型。
 *
 * 原版 `misskey-media-proxy` 使用同名类来区分「业务错误」与「意外错误」：
 * - 客户端错误（4xx）会原样返回给调用方；
 * - 其他错误统一折叠为 500。
 *
 * 在 Worker 中我们还用它区分「上游返回的错误」（例如 404/502）与内部错误。
 */
export class StatusError extends Error {
	/** 建议返回给客户端的 HTTP 状态码。 */
	public readonly statusCode: number;

	/** 可选的状态文本（例如上游的 statusMessage）。 */
	public readonly statusMessage?: string;

	/** 是否为 4xx 客户端错误。 */
	public readonly isClientError: boolean;

	constructor(message: string, statusCode: number, statusMessage?: string) {
		super(message);
		this.name = 'StatusError';
		this.statusCode = statusCode;
		this.statusMessage = statusMessage;
		this.isClientError = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
	}
}
