import { describe, expect, it } from 'vitest';
import { assertSafeUrl, isPrivateAddress, matchesAllowedNetwork } from '../src/ssrf.js';
import { StatusError } from '../src/status-error.js';

/** 断言某个 URL 被拒绝，并返回抛出的错误。 */
function expectRejected(url: string, allowed: string[] = []): StatusError {
	try {
		assertSafeUrl(url, allowed);
	} catch (err) {
		expect(err).toBeInstanceOf(StatusError);
		return err as StatusError;
	}
	throw new Error(`Expected ${url} to be rejected`);
}

describe('assertSafeUrl', () => {
	it('允许普通公网 https URL', () => {
		const url = assertSafeUrl('https://example.com/a.png');
		expect(url.hostname).toBe('example.com');
	});

	it('允许普通公网 http URL', () => {
		expect(assertSafeUrl('http://example.com/a.png').protocol).toBe('http:');
	});

	it('拒绝非法 URL', () => {
		expect(expectRejected('not a url').statusCode).toBe(400);
	});

	it('拒绝非 http(s) 协议', () => {
		expect(expectRejected('ftp://example.com/a.png').statusCode).toBe(400);
		expect(expectRejected('file:///etc/passwd').statusCode).toBe(400);
	});

	it('拒绝 localhost / .internal / .local', () => {
		expect(expectRejected('http://localhost/a.png').statusCode).toBe(403);
		expect(expectRejected('http://foo.internal/a.png').statusCode).toBe(403);
		expect(expectRejected('http://foo.local/a.png').statusCode).toBe(403);
		expect(expectRejected('http://foo.home.arpa/a.png').statusCode).toBe(403);
	});

	it('拒绝字面量私有 IPv4', () => {
		for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1']) {
			expect(expectRejected(`http://${ip}/a.png`).statusCode).toBe(403);
		}
	});

	it('拒绝 IPv6 loopback / link-local / unique-local', () => {
		for (const ip of ['[::1]', '[fe80::1]', '[fc00::1]', '[::]']) {
			expect(expectRejected(`http://${ip}/a.png`).statusCode).toBe(403);
		}
	});

	it('拒绝 IPv4-mapped IPv6 形式的私有地址', () => {
		expect(expectRejected('http://[::ffff:127.0.0.1]/a.png').statusCode).toBe(403);
		expect(expectRejected('http://[::ffff:10.0.0.1]/a.png').statusCode).toBe(403);
	});

	it('允许通过 ALLOWED_PRIVATE_NETWORKS 放行指定网段', () => {
		const url = assertSafeUrl('http://10.1.2.3/a.png', ['10.0.0.0/8']);
		expect(url.hostname).toBe('10.1.2.3');
	});

	it('放行网段不影响其他私有地址', () => {
		expect(expectRejected('http://192.168.1.1/a.png', ['10.0.0.0/8']).statusCode).toBe(403);
	});
});

describe('isPrivateAddress', () => {
	it('公网地址不视为私有', () => {
		expect(isPrivateAddress('8.8.8.8')).toBe(false);
		expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
	});

	it('私有地址视为私有', () => {
		expect(isPrivateAddress('10.0.0.1')).toBe(true);
		expect(isPrivateAddress('::1')).toBe(true);
	});

	it('非法 IP 保守视为私有', () => {
		expect(isPrivateAddress('not-an-ip')).toBe(true);
	});
});

describe('matchesAllowedNetwork', () => {
	it('空列表返回 false', () => {
		expect(matchesAllowedNetwork('10.0.0.1', [])).toBe(false);
	});

	it('命中 CIDR 返回 true', () => {
		expect(matchesAllowedNetwork('10.0.0.1', ['10.0.0.0/8'])).toBe(true);
	});

	it('忽略非法 CIDR', () => {
		expect(matchesAllowedNetwork('10.0.0.1', ['garbage'])).toBe(false);
	});
});
