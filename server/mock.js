// Mock YouCam client — same interface as youcam.js, zero network, zero units.
//
// The response shapes are copied from the documented examples:
//   skin-analysis success  -> { status:200, data:{ task_status:"success", results:{ output:[{type,ui_score,raw_score,mask_urls}] } } }
//   makeup-vto success     -> { status:200, data:{ task_status:"success", results:{ url } } }
// It also simulates the async task lifecycle ("running" for a moment, then "success").
// Scores are deterministic per image (sha256), so the same photo always gives the same result.
//
// Mock masks / try-on images are SVGs generated locally and clearly labelled "MOCK".

import crypto from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seeded(hex) {
  // Small deterministic PRNG from a hex string.
  let s = parseInt(hex.slice(0, 8), 16) || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

const MASK_COLORS = {
  acne: '#e5484d', pore: '#8e4ec6', texture: '#f76b15', moisture: '#0090ff',
  oiliness: '#ffc53d', redness: '#ff6369', wrinkle: '#46a758', dark_circle_v2: '#6e56cf',
  radiance: '#ffe629', age_spot: '#ad7f58', eye_bag: '#3e63dd', firmness: '#12a594',
  droopy_upper_eyelid: '#7c66dc', droopy_lower_eyelid: '#7c66dc', tear_trough: '#5b5bd6', skin_type: '#888',
};

function maskSvg(type, rnd) {
  const color = MASK_COLORS[type] || '#e5484d';
  // Spots roughly inside a centred face oval (assumes a front-facing portrait selfie).
  let dots = '';
  const n = 26 + Math.floor(rnd() * 30);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd());
    const x = 50 + Math.cos(a) * r * 22;
    const y = 50 + Math.sin(a) * r * 30;
    const s = 0.6 + rnd() * 1.6;
    dots += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${s.toFixed(2)}" fill="${color}" fill-opacity="0.75"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">${dots}` +
    `<text x="2" y="98" font-size="3" fill="${color}" font-family="sans-serif">MOCK mask · ${type}</text></svg>`;
}

function vtoSvg(srcBuffer, srcType, effects, width, height) {
  const w = width || 768, h = height || 1024;
  const href = `data:${srcType};base64,${srcBuffer.toString('base64')}`;
  const pick = (cat) => effects.find((e) => e.category === cat)?.palettes?.[0]?.color;
  const lip = pick('lip_color');
  const blush = pick('blush');
  const base = pick('foundation') || pick('concealer');
  const layers = [];
  if (base) layers.push(`<ellipse cx="${w * 0.5}" cy="${h * 0.48}" rx="${w * 0.26}" ry="${h * 0.3}" fill="${base}" fill-opacity="0.18"/>`);
  if (blush) {
    layers.push(`<ellipse cx="${w * 0.36}" cy="${h * 0.55}" rx="${w * 0.07}" ry="${h * 0.04}" fill="${blush}" fill-opacity="0.35" filter="url(#b)"/>`);
    layers.push(`<ellipse cx="${w * 0.64}" cy="${h * 0.55}" rx="${w * 0.07}" ry="${h * 0.04}" fill="${blush}" fill-opacity="0.35" filter="url(#b)"/>`);
  }
  if (lip) layers.push(`<ellipse cx="${w * 0.5}" cy="${h * 0.68}" rx="${w * 0.08}" ry="${h * 0.025}" fill="${lip}" fill-opacity="0.55" filter="url(#b)"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<defs><filter id="b"><feGaussianBlur stdDeviation="${Math.round(w / 80)}"/></filter></defs>` +
    `<image href="${href}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>` +
    `<g style="mix-blend-mode:multiply">${layers.join('')}</g>` +
    `<rect x="0" y="0" width="${w}" height="${Math.round(h * 0.05)}" fill="#000" fill-opacity="0.55"/>` +
    `<text x="${w * 0.02}" y="${h * 0.035}" font-size="${Math.round(h * 0.028)}" fill="#fff" font-family="sans-serif">MOCK try-on preview — set YOUCAM_API_KEY for the real YouCam render</text></svg>`;
}

export function createMockClient({ latencyMs = 900, log = () => {} } = {}) {
  const files = new Map(); // file_id -> {buffer, contentType, width, height}
  const assets = new Map(); // mock://... -> {buffer, contentType}

  async function simulateTask(feature, resultFactory) {
    const taskId = 'mock_' + crypto.randomBytes(12).toString('hex');
    log(`mock ${feature} task ${taskId}: running`);
    await sleep(latencyMs); // "task_status":"running"
    const data = { task_status: 'success', results: resultFactory(taskId) };
    log(`mock ${feature} task ${taskId}: success`);
    return { taskId, data };
  }

  return {
    mode: 'mock',

    async uploadFile(buffer, contentType = 'image/jpeg', _fileName = 'selfie.jpg', meta = {}) {
      const id = 'mockfile_' + crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
      files.set(id, { buffer, contentType, width: meta.width, height: meta.height });
      return id;
    },

    async skinAnalysis(fileId, dstActions) {
      const f = files.get(fileId);
      if (!f) throw new Error('mock: unknown file_id (upload first)');
      const hex = crypto.createHash('sha256').update(f.buffer).digest('hex');
      const { taskId, data } = await simulateTask('skin-analysis', () => {
        const rnd = seeded(hex);
        return {
          output: dstActions.map((type) => {
            const raw = 35 + rnd() * 60; // 35..95, higher = healthier (as documented)
            const ui = Math.round(Math.min(99, 55 + raw * 0.42)); // UI score is documented as a "favourable" calibration of raw
            const key = `mock://mask/${hex.slice(0, 16)}/${type}.svg`;
            assets.set(key, { buffer: Buffer.from(maskSvg(type, seeded(hex + type))), contentType: 'image/svg+xml' });
            return { type, ui_score: ui, raw_score: Number(raw.toFixed(2)), mask_urls: [key] };
          }),
        };
      });
      return { taskId, output: data.results.output, all: null, skin_age: null };
    },

    async makeupVto(fileId, effects) {
      const f = files.get(fileId);
      if (!f) throw new Error('mock: unknown file_id (upload first)');
      const { taskId, data } = await simulateTask('makeup-vto', (tid) => {
        const key = `mock://vto/${tid}.svg`;
        assets.set(key, { buffer: Buffer.from(vtoSvg(f.buffer, f.contentType, effects, f.width, f.height)), contentType: 'image/svg+xml' });
        return { url: key };
      });
      return { taskId, url: data.results.url };
    },

    async download(url) {
      const a = assets.get(url);
      if (!a) throw new Error('mock: asset not found ' + url);
      return a;
    },
  };
}
