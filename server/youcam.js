// Real YouCam API client (v2.0, server-to-server).
//
// Everything here follows the official docs (checked 2026-10-25):
//   - Server:        https://docs.perfectcorp.com/develop/api_server   -> https://yce-api-01.makeupar.com
//   - Auth:          https://docs.perfectcorp.com/develop/quick_start_guide -> "Authorization: Bearer <API key>"
//   - File API:      https://docs.perfectcorp.com/reference/ai_skin_analysis (Step 2-4)
//                    POST /s2s/v2.0/file {files:[{content_type,file_name,file_size}]}
//                    -> data.files[0].file_id + data.files[0].requests[0] {method,url,headers} (pre-signed PUT)
//   - Skin Analysis: POST /s2s/v2.0/task/skin-analysis, poll GET /s2s/v2.0/task/skin-analysis/{task_id}
//                    success -> data.results.output[] {type, ui_score, raw_score, mask_urls[]}
//   - Makeup VTO:    https://docs.perfectcorp.com/reference/makeup_vto
//                    POST /s2s/v2.0/task/makeup-vto {src_file_url|src_file_id, effects[], version:"1.0"}
//                    poll GET /s2s/v2.0/task/makeup-vto/{task_id} -> data.results.url
//   - Rate limit:    https://docs.perfectcorp.com/develop/rate_limit -> 250 req / 300 s per IP and per key (429)
//   - Retention:     https://docs.perfectcorp.com/develop/file_retention_period
//                    file_id 30 days, result download URL valid 2 hours -> we download results immediately.
//
// MEASURED AGAINST A LIVE KEY (2026-10-25):
//   A1. CONFIRMED  makeup-vto accepts `src_file_id` (File API id + PUT upload) — no public URL needed.
//   A2. CONFIRMED  makeup-vto success is `data.results.url` (object form). The `results[].download_url`
//                  form from the schema page was not seen; it is still accepted as a fallback.
//   A3. CONFIRMED  skin-analysis with format:"json" returns everything inside `data.results.output[]`:
//                    - 8 concern entries            {type, ui_score, raw_score, mask_urls[1]}
//                    - {type:"all", score}          overall skin score
//                    - {type:"skin_age", score}     estimated skin age
//                    - {type:"resize_image", mask_urls[1]}  the image the masks line up with
//                  Only the first group are concerns; the others are read separately below.
//   Mask and result files are PNG (RGBA overlays) although the Content-Type did not say PNG (and result URLs end in .jpg),
//   so the server sniffs the bytes to choose the file extension.

const DEFAULT_BASE = 'https://yce-api-01.makeupar.com';

class YouCamError extends Error {
  constructor(message, { status, code, detail } = {}) {
    super(message);
    this.name = 'YouCamError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createYouCamClient({ apiKey, baseUrl = DEFAULT_BASE, pollIntervalMs = 2000, pollTimeoutMs = 180000, log = () => {} }) {
  if (!apiKey) throw new Error('YOUCAM_API_KEY is required for live mode');
  const base = baseUrl.replace(/\/+$/, '');

  async function call(method, path, body, attempt = 1) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // 429: documented rate limit; back off and retry a few times.
    if (res.status === 429 && attempt <= 4) {
      const wait = 1500 * attempt;
      log(`youcam 429 on ${path}, retry in ${wait}ms`);
      await sleep(wait);
      return call(method, path, body, attempt + 1);
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      throw new YouCamError(`YouCam ${method} ${path} failed: ${res.status} ${json.error_code || ''} ${json.error || ''}`.trim(), {
        status: res.status, code: json.error_code, detail: json,
      });
    }
    return json;
  }

  // Step 2-4 of the documented File API flow.
  async function uploadFile(buffer, contentType = 'image/jpeg', fileName = 'selfie.jpg') {
    const init = await call('POST', '/s2s/v2.0/file', {
      files: [{ content_type: contentType, file_name: fileName, file_size: buffer.length }],
    });
    const f = init?.data?.files?.[0];
    const req = f?.requests?.[0];
    if (!f?.file_id || !req?.url) throw new YouCamError('File API response missing file_id/requests.url', { detail: init });
    const put = await fetch(req.url, {
      method: req.method || 'PUT',
      headers: req.headers || { 'Content-Type': contentType, 'Content-Length': String(buffer.length) },
      body: buffer,
    });
    if (!put.ok) throw new YouCamError(`Pre-signed upload failed: ${put.status}`, { status: put.status });
    return f.file_id;
  }

  async function runTask(feature, body) {
    const start = await call('POST', `/s2s/v2.0/task/${feature}`, body);
    const taskId = start?.data?.task_id;
    if (!taskId) throw new YouCamError('task_id missing', { detail: start });
    const t0 = Date.now();
    while (Date.now() - t0 < pollTimeoutMs) {
      await sleep(pollIntervalMs);
      const p = await call('GET', `/s2s/v2.0/task/${feature}/${encodeURIComponent(taskId)}`);
      const st = p?.data?.task_status;
      if (st === 'success') return { taskId, data: p.data };
      if (st === 'error') {
        // Engine error: documented as "no units consumed".
        throw new YouCamError(`Task ${feature} error: ${p.data.error || ''} ${p.data.error_message || ''}`.trim(), {
          code: p.data.error, detail: p.data,
        });
      }
    }
    throw new YouCamError(`Task ${feature} polling timeout`, { code: 'poll_timeout' });
  }

  return {
    mode: 'live',

    uploadFile,

    // dstActions: SD concern names from the docs ("acne","pore","texture","moisture",...).
    async skinAnalysis(fileId, dstActions) {
      const { taskId, data } = await runTask('skin-analysis', {
        src_file_id: fileId,
        dst_actions: dstActions,
        miniserver_args: { enable_mask_overlay: false },
        format: 'json',
      });
      const out = data?.results?.output || [];
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const pick = (t) => num(out.find((o) => o.type === t)?.score);
      return {
        taskId,
        // Concern entries carry numeric ui_score + raw_score; `all`, `skin_age`, `resize_image` do not.
        output: out
          .filter((o) => num(o.ui_score) !== null && num(o.raw_score) !== null)
          .map((o) => ({ type: o.type, ui_score: o.ui_score, raw_score: o.raw_score, mask_urls: o.mask_urls || [] })),
        all: pick('all'),
        skin_age: pick('skin_age'),
      };
    },

    async makeupVto(fileId, effects) {
      const { taskId, data } = await runTask('makeup-vto', {
        src_file_id: fileId, // A1: confirmed live
        effects,
        version: '1.0',
      });
      const r = data?.results;
      const url = (r && !Array.isArray(r) && r.url) || (Array.isArray(r) && (r[0]?.download_url || r[0]?.url)) || null; // A2
      if (!url) throw new YouCamError('makeup-vto success without result url', { detail: data });
      return { taskId, url };
    },

    // Downloads a result asset (mask / try-on image) so we never depend on the 2-hour URL.
    async download(url) {
      const res = await fetch(url);
      if (!res.ok) throw new YouCamError(`download failed ${res.status}`, { status: res.status });
      const buf = Buffer.from(await res.arrayBuffer());
      return { buffer: buf, contentType: res.headers.get('content-type') || 'image/jpeg' };
    },
  };
}

export { YouCamError };
