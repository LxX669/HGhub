import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import bridge from '../src/index.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fakeSource(getData) {
  const paths = [];
  globalThis.fetch = async (_url, options) => {
    const envelope = JSON.parse(options.body);
    paths.push(envelope.path);
    return new Response(JSON.stringify({ status: 1, data: getData(envelope.path) }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return paths;
}

const req = (path, method = 'GET') => new Request(`https://bridge.example${path}`, { method });

test('health works without contacting the source', async () => {
  const response = await bridge.fetch(req('/health'), { ACCESS_KEY: 'secret' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('generates a playable multi-episode M3U list', async () => {
  const paths = fakeSource(() => ({ items: [
    { id: 117, title: '节目"甲\n恶意', episode_count: 2 },
    { id: 118, title: '节目乙', episode_count: 1 },
    { id: 117, title: '重复项目', episode_count: 3 },
  ] }));
  const response = await bridge.fetch(req('/playlist.m3u?category=ai-duanju&size=20'));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(text.startsWith('#EXTM3U\n'));
  assert.equal(text.split('#EXTINF:').length - 1, 3);
  assert.match(text, /\/play\/117\/1\/index\.m3u8/);
  assert.match(text, /\/play\/117\/2\/index\.m3u8/);
  assert.doesNotMatch(text, /\/play\/117\/3\/index\.m3u8/);
  assert.doesNotMatch(text, /\n恶意,/);
  assert.deepEqual(paths, ['/api/videos/category/ai-duanju?page=1&size=20']);
});

test('refreshes the signed video URL on every play', async () => {
  const paths = fakeSource(() => ({ video_url: 'https://yd-lphu-hls.hzjvlo.cn/a/index.m3u8?auth_key=fresh' }));
  const response = await bridge.fetch(req('/play/117/3/index.m3u8'));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://yd-lphu-hls.hzjvlo.cn/a/index.m3u8?auth_key=fresh');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(paths, ['/api/videos/117/play?ep=3&page_texts=0']);
});

test('blocks redirect to an untrusted host and non-https URL', async () => {
  fakeSource(() => ({ video_url: 'http://127.0.0.1/private' }));
  assert.equal((await bridge.fetch(req('/play/117/1/index.m3u8'))).status, 502);
  fakeSource(() => ({ video_url: 'https://evil-hzjvlo.cn/a.m3u8' }));
  assert.equal((await bridge.fetch(req('/play/117/1/index.m3u8'))).status, 502);
});

test('requires key and propagates it to each playback entry', async () => {
  fakeSource(() => ({ items: [{ id: 117, title: '测试', episode_count: 1 }] }));
  const env = { ACCESS_KEY: 'my-secret' };
  assert.equal((await bridge.fetch(req('/playlist.m3u'), env)).status, 401);
  const response = await bridge.fetch(req('/playlist.m3u?key=my-secret'), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /index\.m3u8\?key=my-secret/);
  assert.equal((await bridge.fetch(req('/play/117/1/index.m3u8'), env)).status, 401);
});

test('limits catalog sizes and validates categories', async () => {
  assert.equal((await bridge.fetch(req('/playlist.m3u?pages=20'))).status, 400);
  assert.equal((await bridge.fetch(req('/playlist.m3u?category=unknown'))).status, 400);
  assert.equal((await bridge.fetch(req('/playlist.m3u?size=3.5'))).status, 400);
});

test('supports multiple pages and short-circuits when the page is incomplete', async () => {
  const paths = fakeSource((path) => path.includes('page=1')
    ? { items: [{ id: 100, title: '第一部', episode_count: 4 }, { id: 101, title: '第二部', episode_count: 3 }] }
    : { items: [{ id: 102, title: '第三部', episode_count: 1 }] });
  const response = await bridge.fetch(req('/playlist.m3u?pages=3&size=2&max_episodes=2'));
  const text = await response.text();
  assert.equal(text.split('#EXTINF:').length - 1, 5);
  assert.deepEqual(paths, ['/api/videos?page=1&size=2', '/api/videos?page=2&size=2']);
});

test('handles missing or unexpected response from upstream without mislabeling success', async () => {
  globalThis.fetch = async () => new Response('<html>blocked</html>', { status: 403 });
  const response = await bridge.fetch(req('/playlist.m3u'));
  assert.equal(response.status, 502);
  assert.match(await response.text(), /Source API/);
});

test('supports HEAD but rejects unsupported methods', async () => {
  fakeSource(() => ({ video_url: 'https://tp3.drleao.cn/short/index.m3u8' }));
  const head = await bridge.fetch(req('/play/117/1/index.m3u8', 'HEAD'));
  assert.equal(head.status, 302);
  assert.equal(await head.text(), '');
  assert.equal((await bridge.fetch(req('/playlist.m3u', 'POST'))).status, 405);
});