import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { parseWorkerRequestUrl, resolveWorkerHttpHost, resolveWorkerHttpHostForFork } from '../src/utils/worker-http.js';

function req(url: string | undefined, host?: string): Pick<IncomingMessage, 'url' | 'headers'> {
  return {
    url,
    headers: host === undefined ? {} : { host },
  } as Pick<IncomingMessage, 'url' | 'headers'>;
}

describe('parseWorkerRequestUrl', () => {
  it('parses normal worker HTTP paths and query params', () => {
    const url = parseWorkerRequestUrl(req('/?token=secret', '127.0.0.1:1234'));

    expect(url?.pathname).toBe('/');
    expect(url?.searchParams.get('token')).toBe('secret');
  });

  it('returns null instead of throwing for invalid protocol-relative URLs', () => {
    const url = parseWorkerRequestUrl(req('//..%252f..%252fetc%252fpasswd', '10.0.0.1:1234'));

    expect(url).toBeNull();
  });

  it('uses localhost as a safe base when Host is missing', () => {
    const url = parseWorkerRequestUrl(req('/terminal'));

    expect(url?.host).toBe('localhost');
    expect(url?.pathname).toBe('/terminal');
  });
});

describe('resolveWorkerHttpHost', () => {
  it('defaults worker HTTP to loopback', () => {
    expect(resolveWorkerHttpHost({})).toBe('127.0.0.1');
  });

  it('allows explicit worker HTTP host override', () => {
    expect(resolveWorkerHttpHost({ BOTMUX_WORKER_HTTP_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('falls back to BOTMUX_WORKER_HOST for shorter deployments', () => {
    expect(resolveWorkerHttpHost({ BOTMUX_WORKER_HOST: '::1' })).toBe('::1');
  });

  it('ignores blank overrides', () => {
    expect(resolveWorkerHttpHost({ BOTMUX_WORKER_HTTP_HOST: '  ' })).toBe('127.0.0.1');
  });
});

describe('resolveWorkerHttpHostForFork', () => {
  it('uses loopback by default when the terminal proxy is available', () => {
    expect(resolveWorkerHttpHostForFork({
      env: {},
      terminalProxyPort: 8801,
      webHost: '0.0.0.0',
    })).toBe('127.0.0.1');
  });

  it('preserves direct worker-port fallback when the terminal proxy is unavailable', () => {
    expect(resolveWorkerHttpHostForFork({
      env: {},
      terminalProxyPort: 0,
      webHost: '0.0.0.0',
    })).toBe('0.0.0.0');
  });

  it('lets explicit worker host override proxy-aware defaults', () => {
    expect(resolveWorkerHttpHostForFork({
      env: { BOTMUX_WORKER_HTTP_HOST: '::1' },
      terminalProxyPort: 0,
      webHost: '0.0.0.0',
    })).toBe('::1');
  });
});
