/**
 * ImageService.js
 *
 * Self-hosted image pipeline for catalog artwork:
 *   - fetchAndCache(url): fetches a remote image once, validates it is really
 *     an image, caches it in memory (TTL + entry cap) and returns the entry.
 *     Returns null on ANY failure (timeout, non-image body, too large) so the
 *     caller can fall back to a generated placeholder.
 *   - svgPlaceholder(text, color): generates a category-colored poster card as
 *     an SVG string. Replaces the old external placehold.co dependency.
 *   - svgMatchup(...): composes a two-crest "A vs B" card from team logos that
 *     TeamLogoService resolved, with the logos inlined as data URIs.
 *   - proxyUrl(baseUrl, sourceUrl, opts): builds the /img proxy URL that Nuvio
 *     fetches; the proxy serves the cached image or the generated placeholder,
 *     so a dead source URL can never produce a broken image in the client.
 *
 * No new dependencies: fetches use undici (already in the dependency tree).
 */

const { request } = require('undici');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const IMAGE_TTL_MS = 10 * 60 * 1000;   // 10 minutes
const CACHE_MAX_ENTRIES = 120;
const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 3000;

const cache = new Map();     // url -> { buffer, contentType, expiresAt }
const inFlight = new Map();  // url -> Promise
const negatives = new Map(); // url -> expiry ts (recently failed/slow sources)

const NEG_TTL_MS = 60 * 1000;

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;
  if (u.startsWith('//')) u = 'https:' + u;
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Break text into display lines. Explicit newlines are honoured first; any
 * resulting line longer than maxChars is word-wrapped rather than truncated,
 * so "Northwestern Oklahoma State Rangers" reads in full instead of becoming
 * "Northwestern Oklahoma Sta…".
 */
function wrapLines(text, maxChars, maxLines) {
  const out = [];
  const paras = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const para of paras) {
    if (para.length <= maxChars) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line) {
        line = word;
      } else if ((line + ' ' + word).length <= maxChars) {
        line += ' ' + word;
      } else {
        out.push(line);
        line = word;
      }
      // A single word longer than the budget (rare) still has to be cut.
      while (line.length > maxChars) {
        out.push(line.slice(0, maxChars - 1) + '-');
        line = line.slice(maxChars - 1);
      }
    }
    if (line) out.push(line);
  }
  if (!out.length) return ['Live Sports'];
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/[\s.]+$/, '') + '…';
    return kept;
  }
  return out;
}

function accentColor(color) {
  return /^([0-9a-fA-F]{6})$/.test(String(color)) ? `#${color}` : '#333333';
}

/**
 * Generated poster card: dark background, category-colored accent bar and the
 * title word-wrapped across centered lines. Replaces placehold.co.
 */
function svgPlaceholder(text, color, w = 800, h = 450) {
  const bg = accentColor(color);
  const lines = wrapLines(text, 24, 5);
  const fontSize = lines.length >= 5 ? 34 : lines.length === 4 ? 40 : lines.length === 3 ? 44 : lines.length === 2 ? 52 : 58;
  const lead = fontSize + 12;
  const startY = h / 2 - ((lines.length - 1) * lead) / 2;
  const textEls = lines.map((line, i) => {
    const y = startY + i * lead;
    const isVs = /^(vs|v|at|-)$/i.test(line);
    return `<text x="50%" y="${y.toFixed(1)}" font-family="Segoe UI, Arial, sans-serif" font-size="${isVs ? Math.round(fontSize * 0.6) : fontSize}" font-weight="${isVs ? 400 : 700}" fill="${isVs ? '#9aa0a6' : '#ffffff'}" text-anchor="middle" dominant-baseline="middle">${escapeXml(line)}</text>`;
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#111111"/>
  <rect x="0" y="0" width="${w}" height="10" fill="${bg}"/>
  <rect x="0" y="${h - 10}" width="${w}" height="10" fill="${bg}"/>
  ${textEls}
</svg>`;
}

/**
 * Two-crest matchup card. Logos arrive as { buffer, contentType } entries from
 * getImage() and are inlined as data URIs — an SVG that referenced them by URL
 * would render blank in clients that refuse external refs inside SVG.
 *
 * A missing logo degrades to the team's name in that half, so a one-sided
 * resolve still produces a better card than the plain placeholder.
 */
function svgMatchup(aName, bName, aEntry, bEntry, color, w = 800, h = 450) {
  const bg = accentColor(color);
  const cx = [w * 0.27, w * 0.73];
  const crest = 240;
  const crestMid = h * 0.44;
  const crestY = crestMid - crest / 2;

  const half = (name, entry, i) => {
    const centerX = cx[i];
    if (entry && entry.buffer) {
      const uri = `data:${entry.contentType};base64,${entry.buffer.toString('base64')}`;
      return `<image x="${(centerX - crest / 2).toFixed(1)}" y="${crestY.toFixed(1)}" width="${crest}" height="${crest}" preserveAspectRatio="xMidYMid meet" href="${uri}" xlink:href="${uri}"/>`;
    }
    const lines = wrapLines(name, 14, 3);
    const fs = 30;
    const y0 = crestY + crest / 2 - ((lines.length - 1) * (fs + 6)) / 2;
    return lines.map((l, j) =>
      `<text x="${centerX.toFixed(1)}" y="${(y0 + j * (fs + 6)).toFixed(1)}" font-family="Segoe UI, Arial, sans-serif" font-size="${fs}" font-weight="700" fill="#e8eaed" text-anchor="middle" dominant-baseline="middle">${escapeXml(l)}</text>`
    ).join('\n  ');
  };

  // The caption repeats the name under the crest. When a half already fell back
  // to showing the name in place of a crest, printing it twice just looks broken.
  const caption = (name, entry, i) => {
    if (!entry || !entry.buffer) return '';
    const lines = wrapLines(name, 20, 2);
    const fs = 26;
    return lines.map((l, j) =>
      `<text x="${cx[i].toFixed(1)}" y="${(h * 0.82 + j * (fs + 4)).toFixed(1)}" font-family="Segoe UI, Arial, sans-serif" font-size="${fs}" font-weight="600" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${escapeXml(l)}</text>`
    ).join('\n  ');
  };

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#111111"/>
  <rect x="0" y="0" width="${w}" height="10" fill="${bg}"/>
  <rect x="0" y="${h - 10}" width="${w}" height="10" fill="${bg}"/>
  ${half(aName, aEntry, 0)}
  ${half(bName, bEntry, 1)}
  <text x="50%" y="${crestMid.toFixed(1)}" font-family="Segoe UI, Arial, sans-serif" font-size="44" font-weight="300" fill="#6b7075" text-anchor="middle" dominant-baseline="middle">vs</text>
  ${caption(aName, aEntry, 0)}
  ${caption(bName, bEntry, 1)}
</svg>`;
}

function evictIfNeeded() {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const byAccess = [...cache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const excess = cache.size - CACHE_MAX_ENTRIES;
  for (let i = 0; i < excess; i++) cache.delete(byAccess[i][0]);
}

/**
 * Fetch a remote image once, validate it, cache it. Returns
 * { buffer, contentType } or null on any failure.
 */
async function getImage(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;

  const now = Date.now();
  const neg = negatives.get(url);
  if (neg) {
    if (now < neg) return null; // recently failed/slow: do not re-attempt yet
    negatives.delete(url);
  }

  const hit = cache.get(url);
  if (hit) {
    if (now < hit.expiresAt) { hit.lastAccess = now; return hit; }
    cache.delete(url);
  }

  const pending = inFlight.get(url);
  if (pending) return pending;

  const p = (async () => {
    let result = null;
    try {
      // AbortSignal caps the TOTAL request (headers + body): a slow-loris upstream
      // that trickles bytes can otherwise hang past headersTimeout/bodyTimeout.
      const res = await request(url, {
        headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*;q=0.8' },
        headersTimeout: FETCH_TIMEOUT_MS,
        bodyTimeout: FETCH_TIMEOUT_MS,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + 1000)
      });

      const contentType = String(res.headers['content-type'] || '').split(';')[0].trim();
      // Intentional destroys below (non-image body / size cap) make the undici
      // body emit an 'error' event; without a listener that crashes the process.
      res.body.on('error', () => {});
      if (res.statusCode === 200 && contentType.startsWith('image/')) {
        // Read with a hard size cap so a huge file can never blow the heap.
        const chunks = [];
        let total = 0;
        let tooBig = false;
        for await (const chunk of res.body) {
          total += chunk.length;
          if (total > IMAGE_MAX_BYTES) { tooBig = true; res.body.destroy(); break; }
          chunks.push(chunk);
        }
        if (!tooBig && total >= 32) {
          result = {
            buffer: Buffer.concat(chunks),
            contentType,
            expiresAt: Date.now() + IMAGE_TTL_MS,
            lastAccess: Date.now()
          };
          cache.set(url, result);
          evictIfNeeded();
        }
      }
    } catch (_) {
      result = null;
    } finally {
      inFlight.delete(url);
    }
    if (result) negatives.delete(url);
    else {
      negatives.set(url, Date.now() + NEG_TTL_MS);
      if (negatives.size > 500) negatives.clear();
    }
    return result;
  })();

  inFlight.set(url, p);
  return p;
}

/**
 * Build the /img proxy URL that Nuvio fetches. The proxy serves the cached
 * upstream image or falls back to the generated placeholder, so a dead source
 * URL never reaches the client as a broken image.
 */
function proxyUrl(baseUrl, sourceUrl, { text = '', color = '333333' } = {}) {
  const validUrl = normalizeUrl(sourceUrl);
  if (!validUrl) return null;
  return `${baseUrl}/img?url=${encodeURIComponent(validUrl)}&text=${encodeURIComponent(text)}&color=${color}`;
}

function placeholderUrl(baseUrl, text, color) {
  return `${baseUrl}/img/placeholder?text=${encodeURIComponent(text || '')}&color=${color || '333333'}`;
}

/**
 * Build the /img/matchup URL. At least one logo must be present — with neither,
 * the caller should use placeholderUrl() instead.
 */
function matchupUrl(baseUrl, { a, b, aLogo, bLogo, color = '333333' }) {
  if (!aLogo && !bLogo) return null;
  const q = [
    `a=${encodeURIComponent(a || '')}`,
    `b=${encodeURIComponent(b || '')}`,
    `color=${color}`
  ];
  if (aLogo) q.push(`al=${encodeURIComponent(aLogo)}`);
  if (bLogo) q.push(`bl=${encodeURIComponent(bLogo)}`);
  return `${baseUrl}/img/matchup?${q.join('&')}`;
}

module.exports = {
  svgPlaceholder,
  svgMatchup,
  wrapLines,
  getImage,
  proxyUrl,
  placeholderUrl,
  matchupUrl,
  normalizeUrl
};
