// Routine recommendation engine (pure functions, no API calls, no units).
//
// Input: normalized skin-analysis concerns [{type, uiScore, rawScore}].
// YouCam documents raw/ui scores as 1..100 where HIGHER = healthier
// (https://docs.perfectcorp.com/reference/ai_skin_analysis, "JSON Data Structure").
// So we model "need" for a concern as (100 - rawScore) / 100.
//
// The skin-type label below is OUR heuristic from oiliness/moisture/redness scores, not a YouCam output.
// (YouCam has a dedicated `skin_type` concern; we do not request it to keep each analysis at 8 concerns.)

export const CONCERN_LABELS = {
  acne: 'Breakouts', pore: 'Pores', texture: 'Texture', moisture: 'Hydration', oiliness: 'Oil control',
  redness: 'Redness', wrinkle: 'Fine lines', dark_circle_v2: 'Dark circles', radiance: 'Radiance',
  age_spot: 'Spots', eye_bag: 'Eye bags', firmness: 'Firmness',
};

export const ANALYSIS_PRESETS = {
  // 5-8 concerns = 12 SD units, 1-4 concerns = 9 SD units (api-pricing "Unit Consumption").
  standard: { actions: ['acne', 'pore', 'texture', 'moisture', 'oiliness', 'redness', 'wrinkle', 'dark_circle_v2'], units: 12 },
  lite: { actions: ['acne', 'moisture', 'oiliness', 'redness'], units: 9 },
};

export const UNIT_COST = { makeupVto: 1 };

const STEP_ORDER = ['cleanser', 'toner', 'serum', 'eye', 'moisturizer', 'spf'];

export function inferSkinType(scores) {
  const s = (k) => scores[k] ?? 75;
  const oily = s('oiliness') < 62;
  const dry = s('moisture') < 62;
  const sensitive = s('redness') < 60;
  let base = 'normal';
  if (oily && dry) base = 'combination';
  else if (oily) base = 'oily';
  else if (dry) base = 'dry';
  return { base, sensitive, label: sensitive ? `${base}, redness-prone` : base, heuristic: true };
}

export function recommend(concerns, catalog) {
  const scores = Object.fromEntries(concerns.map((c) => [c.type, c.rawScore]));
  const need = Object.fromEntries(concerns.map((c) => [c.type, Math.max(0, (100 - c.rawScore) / 100)]));
  const skinType = inferSkinType(scores);
  const priorities = [...concerns].sort((a, b) => a.rawScore - b.rawScore).slice(0, 3).map((c) => c.type);

  const scoreProduct = (p) => {
    let s = 0;
    const why = [];
    for (const [concern, w] of Object.entries(p.targets || {})) {
      if (need[concern] === undefined) continue;
      const contrib = need[concern] * w * (priorities.includes(concern) ? 1.5 : 1);
      s += contrib;
      if (contrib > 0.15) why.push(concern);
    }
    const types = p.skinTypes || [];
    if (types.includes(skinType.base)) s += 0.25;
    else s -= 0.4;
    if (skinType.sensitive && types.includes('sensitive')) s += 0.15;
    return { score: Number(s.toFixed(3)), why };
  };

  const skincare = catalog.products.filter((p) => p.kind === 'skincare');
  const routine = { am: [], pm: [] };
  for (const step of STEP_ORDER) {
    const candidates = skincare.filter((p) => p.step === step).map((p) => ({ p, ...scoreProduct(p) })).sort((a, b) => b.score - a.score);
    if (!candidates.length) continue;
    // Eye care only when dark circles are actually a priority-ish concern.
    if (step === 'eye' && !((need.dark_circle_v2 ?? 0) > 0.3)) continue;
    const best = candidates[0];
    for (const t of ['am', 'pm']) {
      if (best.p.time.includes(t)) routine[t].push({ step, productId: best.p.id, score: best.score, why: best.why });
    }
  }

  // Makeup suggestions: complexion products that "help" with the weakest concerns, plus color.
  const makeup = catalog.products.filter((p) => p.kind === 'makeup');
  const complexion = makeup
    .filter((p) => (p.helps || []).some((h) => priorities.includes(h)))
    .map((p) => ({ productId: p.id, why: p.helps.filter((h) => priorities.includes(h)) }));
  const suggestedLook = (need.redness ?? 0) > 0.35 ? 'look-calm' : 'look-fresh';

  const overall = Math.round(concerns.reduce((a, c) => a + c.uiScore, 0) / Math.max(1, concerns.length));

  return { skinType, priorities, routine, complexion, suggestedLook, overall };
}
