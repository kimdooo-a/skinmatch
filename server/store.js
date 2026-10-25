// Content-addressed result cache + unit ledger.
//
// Why: the hackathon redeem code gives 1,000 units. A skin analysis costs 9-16 SD units
// (https://yce.perfectcorp.com/ai-api/api-pricing, "Unit Consumption"), a makeup try-on 1 unit.
// Every paid call is keyed by sha256(photo) + feature + params, so repeating the same request
// (re-rendering a demo, refreshing the page, a judge re-running the flow) costs 0 units.
//
// Layout (all under DATA_DIR, git-ignored):
//   photos/<photoId>.<ext>       uploaded selfie (resized by the browser)
//   photos/<photoId>.json        {contentType,width,height,fileId,fileIdAt,mode}
//   results/<key>.json           normalized API result
//   media/<name>                 downloaded masks / try-on images (YouCam URLs expire after 2 h)
//   ledger.json                  {mode:{spent, calls:[...]}}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function createStore(dataDir) {
  const dirs = ['photos', 'results', 'media'].map((d) => path.join(dataDir, d));
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  const ledgerPath = path.join(dataDir, 'ledger.json');

  const readJson = (p, fallback) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
  };
  const writeJson = (p, v) => {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
    fs.renameSync(tmp, p);
  };

  return {
    dataDir,

    photoPath(photoId, ext) { return path.join(dataDir, 'photos', `${photoId}.${ext}`); },

    savePhoto(buffer, contentType, meta) {
      const photoId = sha256(buffer).slice(0, 24);
      const ext = contentType === 'image/png' ? 'png' : 'jpg';
      fs.writeFileSync(this.photoPath(photoId, ext), buffer);
      const metaPath = path.join(dataDir, 'photos', `${photoId}.json`);
      const prev = readJson(metaPath, {});
      writeJson(metaPath, { ...prev, contentType, ext, width: meta.width || null, height: meta.height || null, savedAt: new Date().toISOString() });
      return photoId;
    },

    getPhoto(photoId) {
      if (!/^[0-9a-f]{24}$/.test(photoId)) return null;
      const meta = readJson(path.join(dataDir, 'photos', `${photoId}.json`), null);
      if (!meta) return null;
      const p = this.photoPath(photoId, meta.ext);
      if (!fs.existsSync(p)) return null;
      return { ...meta, photoId, buffer: fs.readFileSync(p) };
    },

    setPhotoMeta(photoId, patch) {
      const metaPath = path.join(dataDir, 'photos', `${photoId}.json`);
      writeJson(metaPath, { ...readJson(metaPath, {}), ...patch });
    },

    // Deletes the selfie and everything derived from it ("Forget my photo").
    deletePhoto(photoId) {
      if (!/^[0-9a-f]{24}$/.test(photoId)) return 0;
      let n = 0;
      for (const sub of ['photos', 'results', 'media']) {
        const dir = path.join(dataDir, sub);
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(photoId)) { fs.rmSync(path.join(dir, f), { force: true }); n++; }
        }
      }
      return n;
    },

    resultKey(photoId, mode, feature, params) {
      return `${photoId}_${mode}_${feature}_${sha256(Buffer.from(JSON.stringify(params))).slice(0, 16)}`;
    },
    getResult(key) { return readJson(path.join(dataDir, 'results', `${key}.json`), null); },
    putResult(key, value) { writeJson(path.join(dataDir, 'results', `${key}.json`), value); },

    saveMedia(name, buffer) {
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(dataDir, 'media', safe), buffer);
      return `/media/${safe}`;
    },
    mediaPath(name) {
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) return null;
      const p = path.join(dataDir, 'media', name);
      return fs.existsSync(p) ? p : null;
    },

    ledger() { return readJson(ledgerPath, {}); },
    unitsSpent(mode) { return this.ledger()[mode]?.spent || 0; },
    charge(mode, feature, units, detail) {
      const l = this.ledger();
      l[mode] = l[mode] || { spent: 0, calls: [] };
      l[mode].spent += units;
      l[mode].calls.push({ at: new Date().toISOString(), feature, units, ...detail });
      writeJson(ledgerPath, l);
      return l[mode].spent;
    },

    stats() {
      return {
        photos: fs.readdirSync(path.join(dataDir, 'photos')).filter((f) => f.endsWith('.json')).length,
        results: fs.readdirSync(path.join(dataDir, 'results')).length,
      };
    },
  };
}
