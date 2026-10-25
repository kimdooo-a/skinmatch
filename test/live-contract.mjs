// Exercises the REAL client (server/youcam.js) in live mode against a local fake YouCam server
// that answers with the response shapes the real service returned in our first live run (2026-10-25):
// concern entries + {type:"all",score} + {type:"skin_age",score} + {type:"resize_image"} inside output[],
// PNG masks served without a PNG Content-Type, makeup-vto result at data.results.url.
// No real network, no units. It guards the parsing of those shapes; whether the real service still
// accepts our payloads can only be checked with a real key (see the "live verification" notes).
//   node test/live-contract.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const fakePort = await freePort();
const appPort = await freePort();
const FAKE = `http://localhost:${fakePort}`;
const ANALYSIS_ACTIONS = ['acne', 'pore', 'texture', 'moisture', 'oiliness', 'redness', 'wrinkle', 'dark_circle_v2'];
const seen = [];
const uploads = new Map();
const tasks = new Map();

const fake = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, FAKE);
  seen.push(`${req.method} ${u.pathname}`);
  if (u.pathname.startsWith('/s2s/') && req.headers.authorization !== 'Bearer test-key') return json(401, { status: 401, error_code: 'InvalidApiKey' });
  if (req.method === 'POST' && u.pathname === '/s2s/v2.0/file') {
    const f = JSON.parse(body).files[0];
    const id = 'fid_' + uploads.size;
    return json(200, { status: 200, data: { files: [{ content_type: f.content_type, file_name: f.file_name, file_id: id, requests: [{ method: 'PUT', url: `${FAKE}/upload/${id}`, headers: { 'Content-Type': f.content_type, 'Content-Length': String(f.file_size) } }] }] } });
  }
  if (req.method === 'PUT' && u.pathname.startsWith('/upload/')) { uploads.set(u.pathname.slice(8), body.length); res.writeHead(200); return res.end(); }
  const m = u.pathname.match(/^\/s2s\/v2\.0\/task\/(skin-analysis|makeup-vto)(?:\/(.+))?$/);
  if (m && req.method === 'POST') {
    const b = JSON.parse(body);
    if (!uploads.has(b.src_file_id)) return json(404, { status: 404, error_code: 'unknown_internal_error' });
    const id = `task_${tasks.size}`;
    tasks.set(id, { feature: m[1], body: b, polls: 0 });
    return json(200, { status: 200, data: { task_id: id } });
  }
  if (m && req.method === 'GET') {
    const t = tasks.get(m[2]);
    if (!t) return json(404, { status: 404, error_code: 'InvalidTaskId' });
    if (t.polls++ < 1) return json(200, { status: 200, data: { task_status: 'running' } });
    if (t.feature === 'skin-analysis') {
      const output = t.body.dst_actions.map((type, i) => ({ type, ui_score: 70 + i, raw_score: 60.5 + i, mask_urls: [`${FAKE}/asset/${type}.png`], url: null }));
      output.push({ type: 'all', score: 82, url: null }, { type: 'skin_age', score: 29, url: null }, { type: 'resize_image', mask_urls: [`${FAKE}/asset/resize.jpg`], url: null });
      return json(200, { status: 200, data: { error: null, task_status: 'success', results: { output } } });
    }
    return json(200, { status: 200, data: { task_status: 'success', results: { url: `${FAKE}/asset/vto.jpg` } } });
  }
  // Real service: PNG bytes behind generic/misleading headers -> the server must sniff the bytes.
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, 1)]);
  if (u.pathname.startsWith('/asset/')) { res.writeHead(200, { 'Content-Type': 'binary/octet-stream' }); return res.end(u.pathname.endsWith('.png') || u.pathname.endsWith('vto.jpg') ? PNG : Buffer.alloc(64, 1)); }
  json(404, { error: 'fake: no route' });
}).listen(fakePort);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skinmatch-live-'));
const child = spawn(process.execPath, ['server/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(appPort), DATA_DIR: dataDir, YOUCAM_MODE: 'live', YOUCAM_API_KEY: 'test-key', YOUCAM_API_BASE: FAKE, YOUCAM_UNIT_BUDGET: '25' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
for (let i = 0; i < 50 && !out.includes('SkinMatch on'); i++) await new Promise((r) => setTimeout(r, 100));
const base = `http://localhost:${appPort}`;
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

let ok = 0, fail = 0;
const t = (name, fn) => { try { fn(); ok++; console.log('ok  ', name); } catch (e) { fail++; console.log('FAIL', name, '-', e.message); } };
try {
  const st = await (await fetch(base + '/api/status')).json();
  t('mode live, budget 25', () => { assert.equal(st.mode, 'live'); assert.equal(st.budget, 25); });
  const jpg = Buffer.alloc(2000, 7);
  const up = await (await fetch(base + '/api/photo?w=600&h=800', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpg })).json();
  const a = await post('/api/skin-analysis', { photoId: up.photoId, preset: 'standard' });
  t('analysis via real client', () => { assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.concerns.length, 8); assert.ok(a.body.concerns[0].maskUrl); });
  t('all / skin_age / resize_image are not treated as concerns', () => {
    assert.deepEqual(a.body.concerns.map((c) => c.type).sort(), [...ANALYSIS_ACTIONS].sort());
    assert.equal(a.body.apiOverall, 82); assert.equal(a.body.skinAge, 29);
    assert.equal(a.body.recommendation.overall, 82);
    assert.ok(a.body.concerns.every((c) => Number.isFinite(c.uiScore) && Number.isFinite(c.rawScore)));
  });
  t('PNG masks keep a .png extension despite generic Content-Type', () => assert.ok(a.body.concerns.every((c) => c.maskUrl.endsWith('.png')), a.body.concerns.map((c) => c.maskUrl).join()));
  t('pre-signed PUT received full bytes', () => assert.equal([...uploads.values()][0], 2000));
  t('payload has src_file_id + dst_actions + format json', () => { const b = [...tasks.values()][0].body; assert.ok(b.src_file_id); assert.equal(b.dst_actions.length, 8); assert.equal(b.format, 'json'); });
  const v = await post('/api/try-on', { photoId: up.photoId, lookId: 'look-fresh' });
  t('makeup-vto via real client', () => { assert.equal(v.status, 200, JSON.stringify(v.body)); assert.ok(v.body.imageUrl.startsWith('/media/')); assert.ok(v.body.imageUrl.endsWith('.png')); });
  t('file_id reused (1 upload)', () => assert.equal(uploads.size, 1));
  t('vto payload version 1.0 + effects', () => { const b = [...tasks.values()][1].body; assert.equal(b.version, '1.0'); assert.equal(b.effects.length, 3); });
  // 12 + 1 = 13 spent; another full analysis (12) would make 25 -> allowed; a third would exceed.
  const up2 = await (await fetch(base + '/api/photo?w=600&h=800', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(2000, 9) })).json();
  const a2 = await post('/api/skin-analysis', { photoId: up2.photoId });
  t('second analysis within budget', () => assert.equal(a2.status, 200));
  const v2 = await post('/api/try-on', { photoId: up2.photoId, productId: 'mk-lip-berry' });
  t('budget guard blocks overspend (402)', () => { assert.equal(v2.status, 402); assert.equal(v2.body.code, 'budget_guard'); });
  const cachedAgain = await post('/api/skin-analysis', { photoId: up.photoId });
  t('cached result still served at budget cap', () => { assert.equal(cachedAgain.status, 200); assert.equal(cachedAgain.body.unitsCharged, 0); });
} finally {
  child.kill(); fake.close();
}
console.log(`\n${ok}/${ok + fail} passed`);
console.log('fake YouCam saw:', [...new Set(seen)].join(' | '));
if (fail) { console.log('--- server log ---\n' + out); process.exit(1); }
fs.rmSync(dataDir, { recursive: true, force: true });
