# SkinMatch

**From one selfie to a shoppable, try-on-able skincare & makeup routine.**

SkinMatch chains two Perfect Corp. YouCam APIs into a single eCommerce flow:

1. **Selfie** — the browser resizes the photo (short side ≥ 480 px, long side ≤ 2048 px) and sends it to our server.
2. **YouCam AI Skin Analysis** — 8 SD concerns (acne, pores, texture, hydration, oil, redness, fine lines, dark circles) with scores and per-concern detection masks you can toggle over your photo, plus YouCam's overall skin score and estimated skin age.
3. **Routine** — a transparent rule engine ranks a product catalog against your *lowest* scores and an estimated skin type, and builds a morning and an evening routine. Every product says *why* it was picked ("for Redness 71").
4. **YouCam AI Makeup Virtual Try-On** — try a single shade or a whole look (concealer + blush + lip in **one** task) on your own face, with a before/after slider.
5. **Cart → checkout** — add one product or the whole routine; demo checkout summary.

> **Demo video:** https://youtu.be/9tzXaSGC3bE (1–3 min, English narration, live mode against the real YouCam API).

The consumer value: shoppers stop guessing which serum or concealer fits *their* skin, and see the result on their face before buying. For a retailer this is a guided-selling funnel that ends in a basket.

## YouCam APIs used

| API | Endpoint | Used for | Units (per pricing page) |
|---|---|---|---|
| File API | `POST /s2s/v2.0/file` → pre-signed `PUT` | upload the selfie once, reuse its `file_id` | — |
| AI Skin Analysis (SD) | `POST /s2s/v2.0/task/skin-analysis` + `GET …/{task_id}` | scores + masks | 12 (5–8 concerns) · 9 (1–4) |
| AI Makeup Virtual Try-On | `POST /s2s/v2.0/task/makeup-vto` + `GET …/{task_id}` | shade / look try-on | 1 |

Docs: <https://docs.perfectcorp.com/reference/ai_skin_analysis>, <https://docs.perfectcorp.com/reference/makeup_vto>, pricing <https://yce.perfectcorp.com/ai-api/api-pricing>.

Not used: the separate AI Look Virtual Try-On endpoint (`/task/look-vto`). A "look" in SkinMatch is several Makeup VTO effects sent in one `makeup-vto` task.

## Verified against the live API (2026-10-25)

One real run with the bundled sample face: File API upload → Skin Analysis (8 concerns) → Makeup VTO with a single lip shade → Makeup VTO with a 3-effect look. Findings that shaped the code:

- `makeup-vto` accepts a File API `src_file_id` (no public image URL needed).
- Skin Analysis with `format: "json"` returns concerns, the overall score (`type: "all"`), the skin age (`type: "skin_age"`) and a `resize_image` entry, all inside `results.output[]`.
- Mask and try-on result files are PNG although the response Content-Type did not say PNG (and try-on result URLs end in `.jpg`), so the server sniffs file bytes.
- A face narrower than 60% of the image width is rejected by the engine (`error_src_face_too_small`) — surfaced as a friendly 422, no units consumed.

## Built to respect a 1,000-unit budget

- **Content-addressed cache**: every paid result is keyed by `sha256(photo) + feature + params`. Re-running the same analysis or try-on costs 0 units and is marked "cached · 0 units" in the UI.
- **One upload per photo**: the YouCam `file_id` is reused for later tasks (retained 30 days by YouCam).
- **Whole look in one task**: makeup effects are merged into a single Makeup VTO call.
- **In-flight de-duplication**: a double click never pays twice.
- **Budget guard**: `YOUCAM_UNIT_BUDGET` hard-caps what the server may spend; cached results keep working at the cap.
- **Results are downloaded immediately** (YouCam result URLs expire after 2 hours) and served from `/media/`.
- **Unit ledger** in `.data/ledger.json`, shown live in the header.

## Run

Requires Node ≥ 22.9. No `npm install` needed (zero dependencies).

```bash
cp .env.example .env          # put YOUCAM_API_KEY=... here for live mode
npm start                     # live if a key is present, otherwise mock
npm run start:mock            # force mock mode (no network, no units)
npm test                      # mock end-to-end test + live-client contract test (both offline)
```

Open <http://localhost:5178>.

### Test build for judges (no key, no cost)

Anyone can run the full flow without a YouCam account:

```bash
git clone https://github.com/kimdooo-a/skinmatch && cd skinmatch
npm start        # no .env needed -> mock mode (header badge: "MOCK · no API calls")
```

Click **Use sample face → Analyze my skin → See my routine → a look → Add whole routine to cart → Checkout**. Mock mode reproduces the documented response shapes and the task lifecycle with locally drawn masks and try-on previews labelled "MOCK". With a key in `.env` the same flow calls the real YouCam API (header badge: "LIVE · YouCam API").

**Mock mode** reproduces the documented response shapes and task lifecycle (`running` → `success`) with deterministic scores per photo and locally drawn SVG masks/try-on previews labelled "MOCK". It exists so the app can be developed and tested without spending units.

## Architecture

```
public/        static UI (vanilla JS, no build)
server/
  server.js    HTTP routes, cache, budget guard, de-duplication
  youcam.js    real YouCam v2.0 client (File API, task + polling, 429 backoff)
  mock.js      drop-in mock with the same interface
  store.js     content-addressed cache, media store, unit ledger, "forget my photo"
  recommend.js routine engine (pure functions)
data/catalog.json  fictional demo catalog with YouCam Makeup VTO effect payloads
test/          smoke.mjs (mock flow) · live-contract.mjs (real client vs. a fake YouCam server)
```

The API key lives only in the server environment and is never sent to the browser.

## Privacy

Photos are stored only on the server running SkinMatch (`.data/`, git-ignored). **Forget my photo** deletes the selfie and every result derived from it.

## Notes & limitations

- Skin type is a heuristic from oiliness / hydration / redness scores, not a YouCam output. Not medical advice.
- The catalog, brand and prices are fictional demo data.
- The notes at the top of `server/youcam.js` record what was confirmed against the live API. One thing is not confirmed: that a 3-effect look costs 1 unit (the pricing page lists 1 per Makeup VTO task; check your dashboard).

## Generated imagery

`public/samples/sample-face.jpg` is an AI-generated portrait of a fictional person (not a real face). The demo catalog (brand "Dewline (demo)") is fictional.

## License

MIT — see [LICENSE](LICENSE).
