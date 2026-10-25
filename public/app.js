// SkinMatch front end (vanilla JS, no build). Talks only to our server; the API key never reaches the browser.
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
};
const money = (n) => `$${n.toFixed(2)}`;

const state = {
  status: null, catalog: null, byId: {}, photoId: null, photoUrl: null, analysis: null,
  cart: load('skinmatch.cart', {}), // id -> qty
};

function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { code: body.code });
  return body;
}
const postJson = (path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

// ---------- steps ----------
function go(step) {
  for (let i = 1; i <= 4; i++) $(`#step${i}`).hidden = i !== step;
  document.querySelectorAll('.steps li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('active', n === step);
    li.classList.toggle('done', n < step);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function refreshStatus() {
  state.status = await api('/api/status');
  const s = state.status;
  const b = $('#modeBadge');
  b.textContent = s.mode === 'live' ? 'LIVE · YouCam API' : 'MOCK · no API calls';
  b.className = `badge ${s.mode}`;
  $('#units').textContent = s.mode === 'live' ? `units: ${s.unitsSpent} / ${s.budget}` : `mock units: ${s.unitsSpent}`;
}

// ---------- step 1: photo ----------
// Resize in the browser: YouCam auto-resizes above 2560 px and needs short side >= 480 (SD skin analysis).
async function prepareImage(blob) {
  const img = await createImageBitmap(blob);
  const long = Math.max(img.width, img.height), short = Math.min(img.width, img.height);
  if (short < 480) throw new Error(`Photo is ${img.width}×${img.height}; the short side must be at least 480 px.`);
  const scale = Math.min(1, 2048 / long);
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  const jpeg = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  return { jpeg, w, h };
}

async function usePhoto(blob) {
  const msg = $('#msg1');
  msg.className = 'msg'; msg.textContent = 'Preparing photo…';
  try {
    const { jpeg, w, h } = await prepareImage(blob);
    const r = await api(`/api/photo?w=${w}&h=${h}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg });
    state.photoId = r.photoId;
    if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
    state.photoUrl = URL.createObjectURL(jpeg);
    const p = $('#preview');
    p.src = state.photoUrl; p.hidden = false; $('#dropText').hidden = true;
    $('#analyzeBtn').disabled = false;
    msg.textContent = `Photo ready (${w}×${h}). Your photo stays on this server and can be deleted any time.`;
  } catch (e) {
    msg.className = 'msg err'; msg.textContent = e.message;
  }
}

function setupStep1() {
  const drop = $('#drop'), file = $('#file');
  file.addEventListener('change', () => file.files[0] && usePhoto(file.files[0]));
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') file.click(); });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && usePhoto(e.dataTransfer.files[0]));

  $('#sampleBtn').addEventListener('click', async () => {
    const res = await fetch('/samples/sample-face.jpg');
    if (!res.ok) { $('#msg1').className = 'msg err'; $('#msg1').textContent = 'No sample face installed (public/samples/sample-face.jpg).'; return; }
    usePhoto(await res.blob());
  });

  const sel = $('#preset');
  for (const [k, v] of Object.entries(state.status.presets)) {
    sel.append(el('option', { value: k }, `${k === 'standard' ? 'Full check' : 'Quick check'} · ${v.concerns.length} concerns · ${v.units} units`));
  }

  $('#analyzeBtn').addEventListener('click', async () => {
    const btn = $('#analyzeBtn'), msg = $('#msg1');
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Running YouCam AI Skin Analysis…';
    try {
      state.analysis = await postJson('/api/skin-analysis', { photoId: state.photoId, preset: sel.value });
      await refreshStatus();
      renderReport();
      go(2);
      msg.textContent = '';
    } catch (e) {
      msg.className = 'msg err'; msg.textContent = e.message;
    } finally { btn.disabled = false; }
  });
}

// ---------- step 2: report ----------
const scoreColor = (s) => (s >= 80 ? 'var(--good)' : s >= 65 ? 'var(--mid)' : 'var(--bad)');

function renderReport() {
  const a = state.analysis, rec = a.recommendation;
  $('#photo2').src = state.photoUrl;
  const stack = $('#photoStack');
  stack.querySelectorAll('.mask').forEach((m) => m.remove());
  $('#overall').textContent = rec.overall;
  $('#ring').style.setProperty('--p', rec.overall);
  $('#skinType').textContent = `Skin type (estimated): ${rec.skinType.label}` + (Number.isFinite(a.skinAge) ? ` · YouCam skin age: ${a.skinAge}` : '');
  $('#priorities').replaceChildren('Focus: ', ...rec.priorities.map((p) => el('span', { class: 'chip' }, label(p))));
  $('#costNote').replaceChildren(a.cached ? el('span', { class: 'chip cache' }, 'cached · 0 units') : `YouCam task ${a.taskId.slice(0, 10)}… · ${a.unitsCharged} units`);

  const list = $('#concerns');
  list.replaceChildren();
  const sorted = [...a.concerns].sort((x, y) => x.uiScore - y.uiScore);
  for (const c of sorted) {
    let mask = null;
    if (c.maskUrl) { mask = el('img', { class: 'mask', src: c.maskUrl, alt: '' }); stack.append(mask); }
    const row = el('button', { class: 'concern', type: 'button', 'aria-pressed': 'false' },
      el('span', {}, c.label),
      el('span', { class: 'bar' }, el('i', { style: `width:${c.uiScore}%;background:${scoreColor(c.uiScore)}` })),
      el('b', {}, c.uiScore));
    row.addEventListener('click', () => {
      const on = !row.classList.contains('on');
      list.querySelectorAll('.concern').forEach((r) => { r.classList.remove('on'); r.setAttribute('aria-pressed', 'false'); });
      stack.querySelectorAll('.mask').forEach((m) => m.classList.remove('on'));
      if (on) { row.classList.add('on'); row.setAttribute('aria-pressed', 'true'); mask?.classList.add('on'); }
    });
    list.append(row);
  }
}
const label = (type) => state.analysis.concerns.find((c) => c.type === type)?.label || type;

// ---------- step 3: routine + try-on ----------
function productCard(p, why = []) {
  const btn = el('button', { class: 'add', type: 'button' });
  const paint = () => { const n = state.cart[p.id] || 0; btn.textContent = n ? `In cart (${n})` : `Add · ${money(p.price)}`; btn.classList.toggle('added', n > 0); };
  btn.addEventListener('click', () => { addToCart(p.id); paint(); });
  paint();
  const sw = p.kind === 'skincare'
    ? el('div', { class: 'sw', style: `background:linear-gradient(160deg,${p.swatch[0]},${p.swatch[1]})` })
    : el('div', { class: 'sw', style: `background:${p.color}` });
  return el('div', { class: 'prod' }, sw, el('div', {},
    p.step ? el('div', { class: 'step' }, p.step) : null,
    el('div', { class: 'name' }, p.kind === 'makeup' ? `${p.name} — ${p.shade}` : p.name),
    why.length ? el('div', {}, ...why.map((w) => el('span', { class: 'chip' }, `for ${label(w)} ${scoreOf(w)}`))) : el('div', { class: 'muted' }, p.blurb || ''),
    el('div', { class: 'foot' }, el('small', { class: 'muted' }, p.size || p.brand), btn)));
}
const scoreOf = (t) => state.analysis.concerns.find((c) => c.type === t)?.uiScore ?? '';

function renderRoutine() {
  const rec = state.analysis.recommendation;
  for (const t of ['am', 'pm']) $(`#${t}`).replaceChildren(...rec.routine[t].map((r) => productCard(state.byId[r.productId], r.why)));

  const looks = $('#looks');
  looks.replaceChildren(...state.catalog.looks.map((l) => {
    const b = el('button', { class: `look${l.id === rec.suggestedLook ? ' suggested' : ''}`, type: 'button' },
      el('div', {}, el('b', {}, l.name), l.id === rec.suggestedLook ? el('span', { class: 'chip' }, 'suggested') : null),
      el('div', { class: 'dots' }, ...l.items.map((id) => el('span', { class: 'dot', style: `background:${state.byId[id].color}` }))),
      el('small', { class: 'muted' }, `Try full look · ${state.status.tryOnUnits} unit`));
    b.addEventListener('click', () => tryOn({ lookId: l.id }, b));
    return b;
  }));

  const recIds = new Set(rec.complexion.map((c) => c.productId));
  const shades = $('#shades');
  shades.replaceChildren(...state.catalog.products.filter((p) => p.kind === 'makeup').map((p) => {
    const b = el('button', { class: `shade${recIds.has(p.id) ? ' rec' : ''}`, type: 'button' },
      el('span', { class: 'dot', style: `background:${p.color}` }), el('b', {}, p.shade), el('br'),
      el('small', { class: 'muted' }, `${p.category.replace('_', ' ')}${recIds.has(p.id) ? ' · helps your focus areas' : ''}`));
    b.addEventListener('click', () => tryOn({ productId: p.id }, b));
    return b;
  }));

  $('#beforeImg').src = state.photoUrl;
  $('#afterImg').src = state.photoUrl;
}

async function tryOn(sel, btn) {
  const msg = $('#msg3');
  btn.classList.add('busy'); msg.className = 'msg'; msg.textContent = 'Running YouCam Makeup Virtual Try-On…';
  try {
    const r = await postJson('/api/try-on', { photoId: state.photoId, ...sel });
    $('#afterImg').src = r.imageUrl;
    msg.replaceChildren(r.cached ? el('span', { class: 'chip cache' }, 'cached · 0 units') : el('span', { class: 'chip' }, `${r.unitsCharged} unit`), ' Drag the slider to compare.');
    $('#tryOnItems').replaceChildren(el('h3', {}, 'Shown on your photo'), ...r.productIds.map((id) => productCard(state.byId[id])));
    await refreshStatus();
  } catch (e) {
    msg.className = 'msg err'; msg.textContent = e.message;
  } finally { btn.classList.remove('busy'); }
}

// ---------- cart ----------
function addToCart(id, n = 1) {
  state.cart[id] = Math.max(0, (state.cart[id] || 0) + n);
  if (!state.cart[id]) delete state.cart[id];
  save('skinmatch.cart', state.cart);
  renderCart();
}
function cartLines() {
  return Object.entries(state.cart).filter(([id]) => state.byId[id]).map(([id, qty]) => ({ p: state.byId[id], qty }));
}
function renderCart() {
  const lines = cartLines();
  $('#cartCount').textContent = lines.reduce((a, l) => a + l.qty, 0);
  $('#subtotal').textContent = money(lines.reduce((a, l) => a + l.qty * l.p.price, 0));
  $('#cartItems').replaceChildren(...(lines.length ? lines.map(({ p, qty }) => el('div', { class: 'line' },
    el('div', {}, el('b', {}, p.kind === 'makeup' ? `${p.name} — ${p.shade}` : p.name), el('br'), el('small', { class: 'muted' }, money(p.price))),
    el('div', { class: 'qty' }, el('button', { onclick: () => addToCart(p.id, -1), 'aria-label': 'Less' }, '−'), qty, el('button', { onclick: () => addToCart(p.id, 1), 'aria-label': 'More' }, '+'))))
    : [el('p', { class: 'muted' }, 'Your cart is empty.')]));
}
function openCart(open) {
  $('#cart').classList.toggle('open', open);
  $('#cart').setAttribute('aria-hidden', String(!open));
  $('#scrim').hidden = !open;
}
function renderSummary() {
  const lines = cartLines();
  const total = lines.reduce((a, l) => a + l.qty * l.p.price, 0);
  $('#summary').replaceChildren(el('table', {},
    el('tr', {}, el('th', {}, 'Item'), el('th', { class: 'r' }, 'Qty'), el('th', { class: 'r' }, 'Price')),
    ...lines.map(({ p, qty }) => el('tr', {}, el('td', {}, p.kind === 'makeup' ? `${p.name} — ${p.shade}` : p.name), el('td', { class: 'r' }, qty), el('td', { class: 'r' }, money(qty * p.price)))),
    el('tr', {}, el('td', {}, el('b', {}, 'Total')), el('td', {}), el('td', { class: 'r' }, el('b', {}, money(total))))));
}

// ---------- boot ----------
async function boot() {
  await refreshStatus();
  state.catalog = await api('/api/catalog');
  state.byId = Object.fromEntries(state.catalog.products.map((p) => [p.id, p]));
  setupStep1();
  renderCart();

  $('#toRoutine').addEventListener('click', () => { renderRoutine(); go(3); });
  $('#addRoutine').addEventListener('click', () => {
    const rec = state.analysis.recommendation;
    const ids = new Set([...rec.routine.am, ...rec.routine.pm].map((r) => r.productId));
    ids.forEach((id) => { if (!state.cart[id]) addToCart(id); });
    renderRoutine(); openCart(true);
  });
  $('#cartBtn').addEventListener('click', () => openCart(true));
  $('#closeCart').addEventListener('click', () => openCart(false));
  $('#scrim').addEventListener('click', () => openCart(false));
  $('#checkout').addEventListener('click', () => { openCart(false); renderSummary(); go(4); });
  $('#restart').addEventListener('click', () => { state.cart = {}; save('skinmatch.cart', {}); renderCart(); go(1); });
  $('#slider').addEventListener('input', (e) => { $('#afterWrap').style.clipPath = `inset(0 0 0 ${e.target.value}%)`; });
  $('#forget').addEventListener('click', async () => {
    if (!state.photoId) return;
    await api(`/api/photo/${state.photoId}`, { method: 'DELETE' });
    state.photoId = null; state.analysis = null;
    $('#preview').hidden = true; $('#dropText').hidden = false; $('#analyzeBtn').disabled = true;
    $('#msg1').textContent = 'Your photo and its results were deleted from the server.';
    go(1);
  });
  document.querySelectorAll('.steps li').forEach((li) => li.addEventListener('click', () => {
    const n = Number(li.dataset.step);
    if (n === 1 || (n === 2 && state.analysis)) go(n);
    else if (n === 3 && state.analysis) { renderRoutine(); go(3); }
    else if (n === 4) { renderSummary(); go(4); }
  }));
}
boot().catch((e) => { $('#msg1').className = 'msg err'; $('#msg1').textContent = `Startup failed: ${e.message}`; });
