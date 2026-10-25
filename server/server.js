// SkinMatch server — zero dependencies (Node >= 22.9 for --env-file-if-exists).
// Keeps the YouCam API key on the server, caches every paid result, and serves the static UI.
//
//   node --env-file-if-exists=.env server/server.js
//
// Env:
//   YOUCAM_API_KEY      YouCam API key (Bearer). If absent -> mock mode.
//   YOUCAM_MODE         auto (default) | mock | live
//   YOUCAM_API_BASE     default https://yce-api-01.makeupar.com
//   YOUCAM_UNIT_BUDGET  live-mode hard cap on units this server may spend (default 1000)
//   PORT                default 5178
//   DATA_DIR            default ./.data (git-ignored)
//   MOCK_LATENCY_MS     simulated task time in mock mode (default 900)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createYouCamClient } from './youcam.js';
import { createMockClient } from './mock.js';
import { createStore, sha256 } from './store.js';
import { recommend, ANALYSIS_PRESETS, UNIT_COST, CONCERN_LABELS } from './recommend.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));

const env = process.env;
const wantMode = process.argv.includes('--mock') ? 'mock' : (env.YOUCAM_MODE || 'auto').toLowerCase();
const hasKey = Boolean(env.YOUCAM_API_KEY && env.YOUCAM_API_KEY.trim());
if (wantMode === 'live' && !hasKey) {
  console.error('YOUCAM_MODE=live but YOUCAM_API_KEY is empty. Put it in .env (see .env.example).');
  process.exit(1);
}
const MODE = wantMode === 'mock' ? 'mock' : wantMode === 'live' ? 'live' : hasKey ? 'live' : 'mock';
const BUDGET = Number(env.YOUCAM_UNIT_BUDGET || 1000);
const PORT = Number(env.PORT || 5178);
const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || '.data');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const client = MODE === 'live'
  ? createYouCamClient({ apiKey: env.YOUCAM_API_KEY.trim(), baseUrl: env.YOUCAM_API_BASE || undefined, log })
  : createMockClient({ latencyMs: Number(env.MOCK_LATENCY_MS ?? 900), log });
const store = createStore(DATA_DIR);
const inflight = new Map(); // cache key -> Promise (prevents double charges on double clicks)

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Payload too large (max 10 MB, YouCam limit)'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 1024 * 1024);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

const FRIENDLY = {
  error_src_face_too_small: 'Face is too small — the face should cover more than 60% of the photo width.',
  error_src_face_out_of_bound: 'Face is partly outside the photo — center your face.',
  error_lighting_dark: 'Photo is too dark — try even, bright light.',
  error_below_min_image_size: 'Photo is too small — the short side must be at least 480 px.',
  error_no_face: 'No face detected.',
  error_multiple_people: 'More than one person detected.',
  error_large_face_angle: 'Face the camera directly.',
  CreditInsufficiency: 'The YouCam account is out of units.',
  InvalidApiKey: 'The YouCam API key is invalid.',
};

function budgetCheck(units) {
  if (MODE !== 'live') return;
  const spent = store.unitsSpent('live');
  if (spent + units > BUDGET) {
    throw Object.assign(new Error(`Unit budget guard: ${spent} spent + ${units} > YOUCAM_UNIT_BUDGET=${BUDGET}. Cached results still work.`), { status: 402, code: 'budget_guard' });
  }
}

async function ensureFileId(photo) {
  if (MODE === 'mock') return client.uploadFile(photo.buffer, photo.contentType, `selfie.${photo.ext}`, { width: photo.width, height: photo.height });
  // file_id is retained 30 days (docs: file_retention_period); we reuse it for 7 days.
  const fresh = photo.fileId_live && Date.now() - Date.parse(photo.fileIdAt_live || 0) < 7 * 864e5;
  if (fresh) return photo.fileId_live;
  const fileId = await client.uploadFile(photo.buffer, photo.contentType, `selfie.${photo.ext}`);
  store.setPhotoMeta(photo.photoId, { fileId_live: fileId, fileIdAt_live: new Date().toISOString() });
  return fileId;
}

// Live measurement (2026-10-25): YouCam serves PNG overlays under .jpg-looking URLs / generic content types,
// so the extension comes from the file's first bytes, with the Content-Type only as a fallback.
function extFromType(ct, buf) {
  if (buf && buf.length > 12) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  }
  if (ct.includes('svg')) return 'svg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  return 'jpg';
}

async function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- feature handlers ----------
async function analyze(photoId, presetName) {
  const preset = ANALYSIS_PRESETS[presetName] || ANALYSIS_PRESETS.standard;
  const photo = store.getPhoto(photoId);
  if (!photo) throw Object.assign(new Error('Unknown photoId — upload a photo first'), { status: 404 });
  const key = store.resultKey(photoId, MODE, 'skin-analysis-v2', preset.actions); // v2: result shape fixed after the first live run
  const cached = store.getResult(key);
  if (cached) return { ...cached, cached: true, unitsCharged: 0 };

  return once(key, async () => {
    budgetCheck(preset.units);
    const fileId = await ensureFileId(photo);
    const r = await client.skinAnalysis(fileId, preset.actions);
    const concerns = [];
    for (const o of r.output) {
      let maskUrl = null;
      if (o.mask_urls?.[0]) {
        try {
          const dl = await client.download(o.mask_urls[0]);
          maskUrl = store.saveMedia(`${photoId}_${MODE}_mask_${o.type}.${extFromType(dl.contentType, dl.buffer)}`, dl.buffer);
        } catch (e) { log('mask download failed', o.type, e.message); }
      }
      concerns.push({ type: o.type, label: CONCERN_LABELS[o.type] || o.type, uiScore: o.ui_score, rawScore: o.raw_score, maskUrl });
    }
    const spent = store.charge(MODE, 'skin-analysis', preset.units, { photoId, taskId: r.taskId, concerns: preset.actions.length });
    const result = { photoId, mode: MODE, preset: presetName in ANALYSIS_PRESETS ? presetName : 'standard', taskId: r.taskId, concerns, apiOverall: r.all, skinAge: r.skin_age, createdAt: new Date().toISOString() };
    store.putResult(key, result);
    log(`skin-analysis ${photoId} (${MODE}) charged ${preset.units}u, total ${spent}u`);
    return { ...result, cached: false, unitsCharged: preset.units };
  });
}

function effectsFor({ productId, lookId }) {
  const byId = Object.fromEntries(catalog.products.map((p) => [p.id, p]));
  let ids = [];
  if (lookId) {
    const look = catalog.looks.find((l) => l.id === lookId);
    if (!look) throw Object.assign(new Error('Unknown lookId'), { status: 404 });
    ids = look.items;
  } else if (productId) ids = [productId];
  const items = ids.map((id) => byId[id]).filter((p) => p && p.kind === 'makeup');
  if (!items.length) throw Object.assign(new Error('No makeup product to try on'), { status: 400 });
  // One category per task: later items replace earlier ones of the same category.
  const byCat = new Map();
  for (const p of items) for (const e of p.vto) byCat.set(e.category, e);
  return { effects: [...byCat.values()], productIds: items.map((p) => p.id) };
}

async function tryOn(photoId, sel) {
  const photo = store.getPhoto(photoId);
  if (!photo) throw Object.assign(new Error('Unknown photoId — upload a photo first'), { status: 404 });
  const { effects, productIds } = effectsFor(sel);
  const key = store.resultKey(photoId, MODE, 'makeup-vto', effects);
  const cached = store.getResult(key);
  if (cached) return { ...cached, cached: true, unitsCharged: 0 };

  return once(key, async () => {
    // Assumption: Makeup VTO is 1 unit per task regardless of the number of effects (pricing table lists "1").
    budgetCheck(UNIT_COST.makeupVto);
    const fileId = await ensureFileId(photo);
    const r = await client.makeupVto(fileId, effects);
    const dl = await client.download(r.url); // result URL is valid for 2 h only -> keep a local copy
    const imageUrl = store.saveMedia(`${photoId}_${MODE}_vto_${sha256(Buffer.from(key)).slice(0, 12)}.${extFromType(dl.contentType, dl.buffer)}`, dl.buffer);
    const spent = store.charge(MODE, 'makeup-vto', UNIT_COST.makeupVto, { photoId, taskId: r.taskId, productIds });
    const result = { photoId, mode: MODE, taskId: r.taskId, productIds, effects, imageUrl, createdAt: new Date().toISOString() };
    store.putResult(key, result);
    log(`makeup-vto ${photoId} (${MODE}) charged 1u, total ${spent}u`);
    return { ...result, cached: false, unitsCharged: UNIT_COST.makeupVto };
  });
}

// ---------- router ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/status' && req.method === 'GET') {
    return send(res, 200, {
      mode: MODE, budget: MODE === 'live' ? BUDGET : null,
      unitsSpent: store.unitsSpent(MODE), unitsSpentLive: store.unitsSpent('live'),
      presets: Object.fromEntries(Object.entries(ANALYSIS_PRESETS).map(([k, v]) => [k, { units: v.units, concerns: v.actions }])),
      tryOnUnits: UNIT_COST.makeupVto, ...store.stats(),
    });
  }
  if (p === '/api/catalog' && req.method === 'GET') return send(res, 200, catalog);

  if (p === '/api/photo' && req.method === 'POST') {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!['image/jpeg', 'image/png'].includes(ct)) return send(res, 415, { error: 'Send image/jpeg or image/png (YouCam supports jpg/jpeg/png).' });
    const buf = await readBody(req);
    if (buf.length < 100) return send(res, 400, { error: 'Empty image' });
    const width = Number(url.searchParams.get('w')) || null;
    const height = Number(url.searchParams.get('h')) || null;
    if (width && height && Math.min(width, height) < 480) return send(res, 422, { error: FRIENDLY.error_below_min_image_size, code: 'error_below_min_image_size' });
    const photoId = store.savePhoto(buf, ct, { width, height });
    return send(res, 200, { photoId, bytes: buf.length, width, height });
  }
  const del = p.match(/^\/api\/photo\/([0-9a-f]{24})$/);
  if (del && req.method === 'DELETE') return send(res, 200, { deleted: store.deletePhoto(del[1]) });

  if (p === '/api/skin-analysis' && req.method === 'POST') {
    const { photoId, preset = 'standard' } = await readJson(req);
    const result = await analyze(photoId, preset);
    const recommendation = recommend(result.concerns, catalog);
    if (Number.isFinite(result.apiOverall)) recommendation.overall = Math.round(result.apiOverall); // YouCam's own overall score when it returns one
    return send(res, 200, { ...result, recommendation });
  }
  if (p === '/api/recommend' && req.method === 'POST') {
    const { concerns } = await readJson(req);
    if (!Array.isArray(concerns)) return send(res, 400, { error: 'concerns[] required' });
    return send(res, 200, recommend(concerns, catalog));
  }
  if (p === '/api/try-on' && req.method === 'POST') {
    const { photoId, productId, lookId } = await readJson(req);
    return send(res, 200, await tryOn(photoId, { productId, lookId }));
  }

  if (p.startsWith('/media/') && req.method === 'GET') {
    const f = store.mediaPath(decodeURIComponent(p.slice(7)));
    if (!f) return send(res, 404, { error: 'not found' });
    return send(res, 200, fs.readFileSync(f), { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' });
  }

  if (req.method === 'GET') {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const f = path.resolve(PUBLIC, rel);
    if (!f.startsWith(PUBLIC + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, { error: 'not found' });
    return send(res, 200, fs.readFileSync(f), { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  }
  return send(res, 405, { error: 'method not allowed' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const code = e.code || e.detail?.error_code;
    let status = 500;
    if (e.status >= 400 && e.status < 600) status = e.name === 'YouCamError' && e.status >= 500 ? 502 : e.status;
    else if (e.name === 'YouCamError') status = FRIENDLY[code] || String(code || '').startsWith('error_') ? 422 : 502; // engine error = photo problem
    log('error', status, code || '', e.message);
    send(res, status, { error: FRIENDLY[code] || e.message, code: code || null });
  });
});

server.listen(PORT, () => {
  log(`SkinMatch on http://localhost:${PORT}  mode=${MODE}${MODE === 'live' ? ` budget=${BUDGET}u spent=${store.unitsSpent('live')}u` : ' (no units used)'}  data=${DATA_DIR}`);
});

export { server };
