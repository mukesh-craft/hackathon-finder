/**
 * Outbound-request guard tests. No network is touched; every case is decided by
 * URL validation and DNS rules alone.
 */
import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, isPrivateAddress, FetchBlockedError } from '../src/http/safe-fetch.js';

async function blocked(url: string, hosts?: string[]): Promise<string> {
  try {
    await assertUrlAllowed(url, hosts);
    return 'allowed';
  } catch (err) {
    expect(err).toBeInstanceOf(FetchBlockedError);
    return (err as FetchBlockedError).code;
  }
}

describe('isPrivateAddress', () => {
  const privateAddrs = [
    '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::',
    'fe80::1', 'fc00::1',
  ];
  for (const ip of privateAddrs) {
    it(`refuses ${ip}`, () => {
      expect(isPrivateAddress(ip)).toBe(true);
    });
  }

  it('allows ordinary public addresses', () => {
    expect(isPrivateAddress('93.184.216.34')).toBe(false); // example.com
    expect(isPrivateAddress('151.101.1.69')).toBe(false);
  });
});

describe('assertUrlAllowed', () => {
  it('blocks non-http protocols', async () => {
    expect(await blocked('file:///etc/passwd')).toBe('bad_protocol');
    expect(await blocked('gopher://example.com/')).toBe('bad_protocol');
    expect(await blocked('ftp://example.com/x')).toBe('bad_protocol');
  });

  it('blocks malformed URLs', async () => {
    expect(await blocked('not a url')).toBe('malformed_url');
    expect(await blocked('http://')).toBe('malformed_url');
  });

  it('blocks infrastructure ports', async () => {
    expect(await blocked('http://example.com:22/')).toBe('bad_port');
    expect(await blocked('http://example.com:5432/')).toBe('bad_port');
    expect(await blocked('http://example.com:6379/')).toBe('bad_port');
  });

  it('blocks literal private IPs', async () => {
    expect(await blocked('http://127.0.0.1/admin')).toBe('private_address');
    expect(await blocked('http://169.254.169.254/latest/meta-data/')).toBe('private_address');
    expect(await blocked('http://10.1.2.3/')).toBe('private_address');
    expect(await blocked('http://[::1]/')).toBe('private_address');
  });

  it('enforces the per-adapter host allowlist', async () => {
    expect(await blocked('https://evil.example.com/x', ['unstop.com'])).toBe('host_not_allowed');
    expect(await blocked('https://unstop.com.evil.example.com/x', ['unstop.com'])).toBe('host_not_allowed');
  });

  it('allows subdomains of an allowlisted host', async () => {
    // No DNS involved when the host is an IP-checked literal; use a public IP
    // shaped as a subdomain-safe check via the allowlist path only.
    const code = await blocked('https://api.unstop.com/x', ['unstop.com']).catch((e) => (e as FetchBlockedError).code);
    expect(['dns_failure', 'allowed']).toContain(code);
  });
});
