/**
 * HGhub -> SenPlayer IPTV bridge (Cloudflare Worker).
 * Only fetches public catalog metadata and returns temporary playback redirects.
 * It does NOT mirror, decrypt, or proxy copyrighted audio/video.
 */

const DEFAULT_ORIGIN = 'https://huangguoai.com';
const CLIENT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CATEGORY_NAMES = Object.freeze({
  all: '最新短剧',
  'ai-duanju': 'AI成人短剧',
  'ai-manju': 'AI成人漫剧',
  'ai-huanlian': 'AI换脸',
  'ai-mogai': 'AI魔改',
});
const GROUPED_CATEGORIES = Object.freeze(['ai-duanju', 'ai-manju', 'ai-huanlian', 'ai-mogai']);
const BASE_MEDIA_HOSTS = ['hzjvlo.cn', 'drleao.cn'];

class BridgeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function textResponse(text, status = 200, type = 'text/plain; charset=utf-8') {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function parseCount(search, name, fallback, max) {
  const raw = search.get(name);
  if (raw === null) return fallback;
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) {
    throw new BridgeError(400, `${name} must be a positive integer`);
  }
  const count = Number(raw);
  if (count > max) throw new BridgeError(400, `${name} must be <= ${max}`);
  return count;
}

function safeM3uText(value, maxLength = 100) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/"/g, '＂')
    .trim()
    .slice(0, maxLength);
}

function requestOrigin(env) {
  const configured = String(env?.UPSTREAM_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, '');
  const url = new URL(configured);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new BridgeError(500, 'UPSTREAM_ORIGIN must be an HTTPS origin');
  }
  return url.origin;
}

function authorised(requestUrl, env) {
  const expected = String(env?.ACCESS_KEY || '');
  if (!expected) return true;
  const actual = requestUrl.searchParams.get('key') || '';
  if (expected.length !== actual.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return mismatch === 0;
}

function validMediaUrl(value, env) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const extra = String(env?.ALLOWED_MEDIA_HOSTS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const domains = [...BASE_MEDIA_HOSTS, ...extra];
    return url.protocol === 'https:' && !url.username && !url.password &&
      domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

async function upstreamGet(path, env) {
  const origin = requestOrigin(env);
  const endpoint = `${origin}/api/edge/request`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Referer': `${origin}/`,
        'User-Agent': CLIENT_UA,
      },
      body: JSON.stringify({ method: 'GET', path, body: '', content_type: '' }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new BridgeError(502, 'Cannot reach source API');
  }
  if (!response.ok) throw new BridgeError(502, `Source API returned HTTP ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new BridgeError(502, 'Source API did not return JSON');
  }
  if (payload?.status !== 1 || payload.data == null) {
    throw new BridgeError(502, 'Source API rejected the request');
  }
  return payload.data;
}

async function playlist(url, env) {
  const category = url.searchParams.get('category') || 'all';
  if (category !== 'grouped' && !Object.hasOwn(CATEGORY_NAMES, category)) {
    throw new BridgeError(400, `Invalid category: ${category}`);
  }
  const pages = parseCount(url.searchParams, 'pages', 1, 3);
  const size = parseCount(url.searchParams, 'size', 20, 30);
  const maxEpisodes = parseCount(url.searchParams, 'max_episodes', 60, 120);
  const origin = url.origin;
  const suffix = env?.ACCESS_KEY ? `?key=${encodeURIComponent(url.searchParams.get('key') || '')}` : '';
  const lines = ['#EXTM3U'];
  const categories = category === 'grouped' ? GROUPED_CATEGORIES : [category];

  for (const currentCategory of categories) {
    const group = safeM3uText(`HGhub · ${CATEGORY_NAMES[currentCategory]}`);
    const seen = new Set();
    for (let page = 1; page <= pages; page++) {
      const path = currentCategory === 'all'
        ? `/api/videos?page=${page}&size=${size}`
        : `/api/videos/category/${currentCategory}?page=${page}&size=${size}`;
      const data = await upstreamGet(path, env);
      if (!Array.isArray(data.items)) throw new BridgeError(502, 'Invalid catalog response');
      for (const video of data.items) {
        const id = Number(video?.id);
        const episodes = Number(video?.episode_count);
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(episodes) || episodes <= 0) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        const showTitle = safeM3uText(video.title || `短剧 ${id}`, 70);
        for (let ep = 1; ep <= Math.min(episodes, maxEpisodes); ep++) {
          const title = safeM3uText(`${showTitle} · 第${ep}集`);
          lines.push(`#EXTINF:-1 tvg-id="hghub-${id}-${ep}" tvg-name="${title}" group-title="${group}",${title}`);
          lines.push(`${origin}/play/${id}/${ep}/index.m3u8${suffix}`);
        }
      }
      if (data.items.length < size) break;
    }
  }

  if (lines.length === 1) throw new BridgeError(502, 'Catalog did not contain any available episodes');
  return textResponse(`${lines.join('\n')}\n`, 200, 'application/vnd.apple.mpegurl; charset=utf-8');
}

async function play(id, ep, env) {
  const data = await upstreamGet(`/api/videos/${id}/play?ep=${ep}&page_texts=0`, env);
  const mediaUrl = data?.video_url;
  if (typeof mediaUrl !== 'string' || !validMediaUrl(mediaUrl, env)) {
    throw new BridgeError(502, 'The source returned an unsupported or unsafe playback URL');
  }
  return new Response(null, {
    status: 302,
    headers: {
      'Location': mediaUrl,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method)) {
      return textResponse('Method Not Allowed', 405);
    }
    if (url.pathname === '/health') {
      return textResponse(JSON.stringify({ ok: true, service: 'hghub-senplayer-bridge', version: '0.2.0' }), 200, 'application/json; charset=utf-8');
    }
    if (url.pathname === '/') {
      return textResponse('HGhub SenPlayer bridge\nSubscribe: /playlist.m3u?category=all\nCategories: all, grouped, ai-duanju, ai-manju, ai-huanlian, ai-mogai\nSee bridge/README.md on GitHub for setup.\n');
    }
    if (!authorised(url, env)) return textResponse('Unauthorized: missing or invalid key', 401);
    try {
      let response;
      if (url.pathname === '/playlist.m3u') {
        response = await playlist(url, env);
      } else {
        const match = /^\/play\/([1-9][0-9]{0,11})\/([1-9][0-9]{0,3})\/index\.m3u8$/.exec(url.pathname);
        if (!match) return textResponse('Not Found', 404);
        response = await play(Number(match[1]), Number(match[2]), env);
      }
      if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
      return response;
    } catch (error) {
      if (error instanceof BridgeError) return textResponse(error.message, error.status);
      return textResponse('Internal Server Error', 500);
    }
  },
};