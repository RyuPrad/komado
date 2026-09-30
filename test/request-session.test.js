import http from 'node:http';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCache } from '../src/lib/cache.js';
import { beginRequestSession, endRequestSession, fetchWithBackoff } from '../src/lib/fetchWithBackoff.js';

let session;
beforeEach(() => { session = beginRequestSession(); });
afterEach(() => {
  endRequestSession(session);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function localServer(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('app HTTP lifetime', () => {
  it('keeps shared work alive across screen cancellation and closes it on app exit', async () => {
    let networkSignal;
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => {
      networkSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }));
    const cache = createCache();
    const screen = new AbortController();
    const load = () => fetchWithBackoff('https://fixture.invalid', { retries: 0 });
    const cancelled = cache.wrap('shared', load, undefined, { signal: screen.signal });
    const current = cache.wrap('shared', load);
    const currentError = expect(current).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(networkSignal).toBeDefined());
    screen.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(networkSignal.aborted).toBe(false);
    endRequestSession(session);
    await currentError;
    expect(networkSignal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ends a retry wait and fences late requests from the closed session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('retry', {
      status: 429, headers: { 'retry-after': '3600' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchWithBackoff('https://fixture.invalid');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    endRequestSession(session);
    await rejected;
    await expect(fetchWithBackoff('https://fixture.invalid/late')).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('cancels a pending response body after headers (fallback=%s)', async (fallback) => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    if (fallback) Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
    const server = await localServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('partial body');
    });
    try {
      const response = await fetchWithBackoff(server.url, { retries: 0 });
      expect(response.url).toBe(server.url + '/');
      const body = response.text();
      const rejected = expect(body).rejects.toMatchObject({ name: 'AbortError' });
      endRequestSession(session);
      await rejected;
      if (fallback) expect(getEventListeners(session.signal, 'abort')).toHaveLength(0);
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
      await server.close();
    }
  });

  it('releases fallback listeners when the response body completes', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
    const server = await localServer((_request, response) => response.end('complete'));
    try {
      const response = await fetchWithBackoff(server.url, { retries: 0 });
      expect(await response.text()).toBe('complete');
      expect(getEventListeners(session.signal, 'abort')).toHaveLength(0);
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
      await server.close();
    }
  });

  it('lets the process exit promptly after cancelling a shared HTTP load', async () => {
    const server = await localServer(() => {});
    const fetchModule = new URL('../src/lib/fetchWithBackoff.js', import.meta.url).href;
    const cacheModule = new URL('../src/lib/cache.js', import.meta.url).href;
    const script = `
      import { beginRequestSession, endRequestSession, fetchWithBackoff } from ${JSON.stringify(fetchModule)};
      import { createCache } from ${JSON.stringify(cacheModule)};
      const session = beginRequestSession();
      createCache().wrap('shared', () => fetchWithBackoff(${JSON.stringify(server.url)}, { timeoutMs: 30000, retries: 0 }))
        .catch(() => process.stdout.write('closed'));
      setTimeout(() => endRequestSession(session), 50);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    let timer;
    try {
      const code = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('HTTP kept the app process alive')), 5000);
        child.once('exit', resolve);
        child.once('error', reject);
      });
      expect(code).toBe(0);
      expect(output).toBe('closed');
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      await server.close();
    }
  });
});
