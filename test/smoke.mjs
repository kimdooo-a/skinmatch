// End-to-end smoke test in MOCK mode (no network, no units).
// Starts the real server on a free port with a temp DATA_DIR and walks the whole user flow.
//   node test/smoke.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal PNG encoder: a synthetic 600x800 gradient (NOT a face; mock mode does not detect faces).
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 200 + (x % 55); raw[o + 1] = 150 + (y % 80); raw[o + 2] = 130;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skinmatch-'));
const child = spawn(process.execPath, ['server/server.js', '--mock'], {
  cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, MOCK_LATENCY_MS: '150', YOUCAM_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const base = `http://localhost:${port}`;
for (let i = 0; i < 50 && !out.includes('SkinMatch on'); i++) await new Promise((r) => setTimeout(r, 100));

const j = async (p, opts) => { const r = await fetch(base + p, opts); return { status: r.status, body: await r.json() }; };
const post = (p, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const results = [];
const check = (name, fn) => results.push([name, fn]);

try {
  const st = await j('/api/status');
  check('status mock', () => assert.equal(st.body.mode, 'mock'));

  const html = await fetch(base + '/');
  check('index.html 200', () => assert.equal(html.status, 200));
  for (const f of ['/app.js', '/styles.css']) { const r = await fetch(base + f); check(`${f} 200`, () => assert.equal(r.status, 200)); }

  const cat = await j('/api/catalog');
  check('catalog has products', () => assert.ok(cat.body.products.length >= 10));

  const small = await fetch(base + '/api/photo?w=300&h=400', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png(300, 400) });
  check('too-small photo rejected 422', () => assert.equal(small.status, 422));

  const up = await j('/api/photo?w=600&h=800', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png(600, 800) });
  check('photo upload 200', () => assert.equal(up.status, 200));
  const photoId = up.body.photoId;

  const a1 = await post('/api/skin-analysis', { photoId, preset: 'standard' });
  check('analysis 200', () => assert.equal(a1.status, 200, JSON.stringify(a1.body)));
  check('analysis 8 concerns', () => assert.equal(a1.body.concerns.length, 8));
  check('analysis charged 12', () => assert.equal(a1.body.unitsCharged, 12));
  check('masks saved', () => assert.ok(a1.body.concerns.every((c) => c.maskUrl?.startsWith('/media/'))));
  check('routine am/pm', () => { assert.ok(a1.body.recommendation.routine.am.length >= 3); assert.ok(a1.body.recommendation.routine.pm.length >= 3); });

  const a2 = await post('/api/skin-analysis', { photoId, preset: 'standard' });
  check('analysis cache hit 0 units', () => { assert.equal(a2.body.cached, true); assert.equal(a2.body.unitsCharged, 0); });

  const mask = await fetch(base + a1.body.concerns[0].maskUrl);
  check('mask served', () => assert.equal(mask.status, 200));

  const rec = await post('/api/recommend', { concerns: [{ type: 'redness', uiScore: 55, rawScore: 40 }, { type: 'moisture', uiScore: 60, rawScore: 45 }, { type: 'oiliness', uiScore: 85, rawScore: 80 }] });
  check('recommend dry+sensitive -> look-calm', () => { assert.equal(rec.body.skinType.base, 'dry'); assert.equal(rec.body.suggestedLook, 'look-calm'); });

  const t1 = await post('/api/try-on', { photoId, productId: 'mk-lip-berry' });
  check('try-on product 200', () => { assert.equal(t1.status, 200, JSON.stringify(t1.body)); assert.equal(t1.body.unitsCharged, 1); });
  const img = await fetch(base + t1.body.imageUrl);
  check('try-on image served', () => assert.equal(img.status, 200));

  const t2 = await post('/api/try-on', { photoId, lookId: 'look-calm' });
  check('try-on look = 1 task, 3 effects', () => { assert.equal(t2.body.effects.length, 3); assert.equal(t2.body.unitsCharged, 1); });
  const t3 = await post('/api/try-on', { photoId, lookId: 'look-calm' });
  check('try-on cache hit', () => assert.equal(t3.body.unitsCharged, 0));

  const [p1, p2] = await Promise.all([post('/api/try-on', { photoId, productId: 'mk-lip-coral' }), post('/api/try-on', { photoId, productId: 'mk-lip-coral' })]);
  check('double click charged once', () => assert.equal(p1.body.unitsCharged + p2.body.unitsCharged <= 2, true));

  const st2 = await j('/api/status');
  check('ledger = 12 + 1 + 1 + 1', () => assert.equal(st2.body.unitsSpent, 15));

  const bad = await post('/api/try-on', { photoId: 'f'.repeat(24), productId: 'mk-lip-berry' });
  check('unknown photo 404', () => assert.equal(bad.status, 404));

  const del = await j(`/api/photo/${photoId}`, { method: 'DELETE' });
  check('forget photo deletes files', () => assert.ok(del.body.deleted >= 3));
  const gone = await post('/api/skin-analysis', { photoId });
  check('deleted photo -> 404', () => assert.equal(gone.status, 404));
} finally {
  child.kill();
}

let fail = 0;
for (const [name, fn] of results) {
  try { fn(); console.log('ok  ', name); } catch (e) { fail++; console.log('FAIL', name, '-', e.message); }
}
console.log(`\n${results.length - fail}/${results.length} passed`);
if (fail) { console.log('--- server log ---\n' + out); process.exit(1); }
fs.rmSync(dataDir, { recursive: true, force: true });
