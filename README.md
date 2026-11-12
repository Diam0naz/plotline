# Plotline

Offline-first GNSS farm mapping, scouting and verifiable records for smallholder farmers.
Works in a phone browser, installs as a PWA, and keeps working with no network.

## Run

```
npm start          # site, app, console and ledger on http://localhost:8123
npm test           # unit, ledger, registry, cache and API tests (Node 20+)
```

- `/` — the website, which links into the app
- `/app.html` — the farmer app (the PWA `start_url`)
- `/console.html` — the operator and verifier console

`PORT`, `DATA_DIR`, `ADMIN_TOKEN` and `REDIS_URL` are optional. Caching is read-through Redis with a
few-second TTL on the public registry views; if Redis is missing or dies, every request falls through
to the registry and the app keeps working (`REDIS_URL=off` disables it explicitly).

The server prints an operator token on start (or set `ADMIN_TOKEN`). To load a demo: start with an empty data folder, then
`ADMIN_TOKEN=<token> node scripts/seed.mjs http://localhost:8123` and open `/console.html`.

The app submits under the project named in `<meta name="plotline-project">` in `app.html`. The seed script registers `PRJ-0001` for it; change the meta tag when you register a different project. An unregistered project is refused with a clear message. Data folders written before credits were denominated in tonnes keep their old tree-year issuances, so start a fresh `DATA_DIR` for the current model.

GNSS and the service worker need a secure origin: `localhost` works for testing; real phones need HTTPS.

## Roles and sign-in

Plotline uses a strict unified authentication interface. All roles — Standard Users, Verifiers, and Admins — sign in through the same single login form (Email/Username and Password). Signature: there is exactly one auth surface in the app — the full-page dark gateway. Auth is never a popup or floating modal; every sign-in / create-account button routes to that gateway (from the site, `app.html?join=signup` opens it directly on the sign-up panel). A user looking at the login or signup interface cannot tell that privileged roles exist in the system.

- **Gateway modes**: two "device identity" tabs (create the key that lives on the phone / welcome back) and two "Server account" tabs (sign in / create account). Switching between them stays inside the same page.
- **Unified Sign-In**: A single server login form is used by all roles.
- **Restricted Sign-Up**: Public account creation ("Sign Up") only allows standard users to self-register with their full name, email, username, and password. There is no Admin or Verifier sign-up.
- **Role-Based Redirection**: Upon successful authentication through the unified form, the frontend inspects the user's role payload:
  - `admin` is routed to the console / admin dashboard (`/console.html` overview).
  - `verifier` is routed directly to the submissions queue (`/app.html` Submissions tab or `/console.html` review queue).
  - Standard users (`user`) are routed to the standard app view (`/app.html`) — or straight back to the "Apply to be a verifier" form when their click before sign-in signalled that intent.

### Admin access

Admins sign in using the standard public login form with the fixed username `admin`. There is no sign-up for admins; the account is pre-provisioned at boot one of two ways:

1. **`ADMIN_PASSWORD` env var** (recommended for any real deployment):
   ```
   ADMIN_PASSWORD=mysecurepass node server/server.mjs
   ```
2. **Operator token** (default dev mode): when `ADMIN_PASSWORD` is not set, the server prints a random token on start — use it as the password. Example output:
   ```
   operator token: 3f8a2c1d9e4b7f6a
   ```
   Sign in through the unified public login form as `admin` with that token as the password. The system inspects the role and redirects to the admin console dashboard.

The Bearer token is for scripts and direct API calls only, not for the UI:
```
Authorization: Bearer <operator-token>
```

To load demo data:
```
ADMIN_TOKEN=<token> node scripts/seed.mjs http://localhost:8123
```

### Verifier application and activation code process

Verifiers are upgraded standard users. Standard users do not see verifier routes or navigation tabs by default.

1. **Application**: Logged-in standard users can access an "Apply to be a Verifier" flow in the Profile tab, submitting their full name, email, organisation, and qualification reason (`POST /api/auth/apply`).
2. **Admin approval**: Administrators review pending applications in the admin console. Approving an application generates a unique activation code (e.g. `VACT-XXXX-XXXX`), provided to the approved user off-band.
3. **Activation**: The standard user enters their activation code into the "Activate verifier role" component in the Profile tab (`POST /api/auth/activate`).
4. **Upgrade & Unlock**: Submitting a valid activation code immediately upgrades the user's account and session to the `verifier` role. This dynamically unlocks and displays the Verifier navigation tabs and Submissions Queue in their user-facing app view, and routes them straight to the queue. Verifiers can review submissions in the app or via the full console.

Decisions in the review queue are signed with the verifier's browser-local ECDSA key — the signature, not the login session, authorises each decision in the registry.

### Farmer app structure

The farmer app (`app.html`) is organised around a phone-friendly bottom nav and an avatar user menu:

- **Home (dashboard)** — the landing tab for every role: greeting, live stats computed on this phone (farms, total area, scout reports, records sealed, trees tracked), quick actions (walk boundary, report sighting, seal records, review queue for verifiers) and recent activity.
- **Profile** — the identity card (display name kept on-device, signing key fingerprint, local record counts), the server account state (username, role, session expiry) with sign-in/out, and the verifier application/activation flow.
- **Settings** — security (the device-local PIN lock screen, which covers the whole app until unlocked, with a reset path for a forgotten PIN), key backup and multi-device sync, the optional ledger key, data export/demo/reset, and about info.
- **Proper sign-out** — the avatar menu (top-right) holds profile/settings/sign-out. Sign out ends the server session through `POST /api/auth/logout`; the device identity and its records always stay on the phone.

Decisions in the review queue are signed with the verifier's browser-local ECDSA key — the signature, not the login session, authorises each decision in the registry.

### Security and session machinery

- **Passwords** are hashed with scrypt (N=16384, r=8, p=1, per-hash salt) and compared in constant time; plaintext never touches disk.
- **Sessions** are random 256-bit tokens in an HttpOnly, SameSite=Lax cookie (Secure on non-localhost origins), expiring after 12 hours. The server stores only `sha256(token)` in `data/sessions.json` (mode 0600) and purges expired sessions on use — a copy of the data directory cannot be replayed as a login.
- **Path protection**: operator routes accept an admin session *or* the operator token; the submissions queue accepts admins and signed-in verifiers; everyone else sees only the public routes. Cookie-authenticated writes must carry a matching `Origin`, so a stolen-cookie request from another host is refused; login is rate-limited per IP.
- **Every response** carries the security headers: a Content-Security-Policy, `x-frame-options: DENY` and no referrer.
- **Farmers (the app's users) have no server accounts by design**: their identity is the P-256 key on the phone, and offline-first use must never depend on a connection. The app's optional **PIN lock** is a device-local privacy screen (nothing renders until the PIN unlocks it), not account security.

## Pitch deck

`pitch-deck.html` is a self-contained 14-slide deck (no dependencies, same offline-first rules as the app). Open it directly in a browser, present full-screen (F11) with →/space, or serve it with the app at [`/pitch-deck.html`](http://localhost:8123/pitch-deck.html). Ctrl+P prints one slide per landscape A4 page. Everything on it is either verified against the codebase or marked with a `——` placeholder to fill in before presenting.

## AI photo check (best-effort, offline-first)

`POST /api/classify` runs up to 5 field photos of one plant through a vision model and returns one structured verdict:

```json
{ "label": "Gray Leaf Spot", "confidence": 0.87, "severity": "medium",
  "notes": "Lesions on the lower canopy…", "commonName": "Maize",
  "botanicalName": "Zea mays", "pathogenName": "Cercospora zeae-maydis", "provider": "gemini" }
```

- **Providers in order**: OpenAI (`OPENAI_API_KEY`, model `OPENAI_VISION_MODEL`, default `gpt-6-astra`) then Gemini (`GEMINI_API_KEY`, `GEMINI_MODEL`, default `gemini-3.5-flash-lite`). The first success wins; a hard client fault (bad key, bad payload) stops the chain honestly instead of wasting the fallback. All attempts must fit inside `CLASSIFY_TOTAL_BUDGET_MS` (42 s) with per-attempt caps of 20 s.
- **One prompt, one schema**: both providers share the same system prompt and strict JSON schema (`server/classify.mjs`), so verdicts are comparable across providers, and responses are clamped on this side (label ≤ 48 chars, confidence 0–1, severity vocabulary) before reaching the app.
- **It is a suggestion**: the app shows label + confidence + notes and lets the scout confirm or overrule the type and severity before saving. The report itself works fully offline; without signal, the AI chip says so and the report saves without an AI label.
- **Provenance, not bulk**: photos are downscaled to 1024 px / JPEG 0.6 on the phone, kept in memory only, and their SHA-256 hashes (not the bytes) are signed into the scout record, so any later photo can be tied to its record without bloating localStorage.
- **Costs are rate-limited**: 10 classifications per IP per minute; the endpoint answers `503 ai_unconfigured` when no key is set, and the whole feature degrades to nothing.

## What it does

| Tab | Feature |
|---|---|
| Farm | Walk the boundary, mark corner points, get area and perimeter. Fixes worse than 50 m are refused. |
| Farm › Seed & fertiliser | Seed and fertiliser quantities from the walked area. Rates are editable starting points, not recommendations. |
| Scout | Geotagged, signed field reports (pest, disease, water stress, weeds, nutrient, healthy) with a GNSS quality score. Up to 3 photos are hashed into the record, and an optional "Check with AI" runs the photos through a vision model to suggest a diagnosis — a suggestion the scout confirms, never an auto-label. |
| Scout › Outbreaks | Heat map of reports and outbreak alerts (3+ reports of one problem within 1 km in 14 days). Reports with quality under 50 are left out. |
| Trees | Record planting and a survival check, send them for verification, see status and payouts. |
| Records | Seal records into a batch (Merkle root), publish it to the ledger, and verify any record. |

## How records are verified (and free to the farmer)

1. Each record is canonicalised, hashed (SHA-256) and signed on the phone with an ECDSA P-256 key.
2. "Seal" groups pending records under one Merkle root. Many records, one fingerprint.
3. The app sends **only the root and a count** to the ledger (`POST /api/anchor`). Records never leave the phone. No fee, no wallet.
4. The ledger is append-only and hash-chained: each entry commits to the previous one, so editing or removing any past entry breaks every entry after it. The server refuses to start on a ledger that fails verification.
5. Verify a record: its hash matches, its signature is valid, a Merkle proof places it in the batch, and the batch root is in the ledger (re-checked live when online).
6. Offline: sealing works; batches wait and publish automatically when the connection returns.

## Climate layer: verified carbon credits to payouts (Access Youth Tech Forge, Theme 2)

**Climate activity:** farmer-managed agroforestry (trees planted and kept alive on smallholdings).
**Activity measure:** one verified tree-year, meaning one tree shown to be alive for one monitoring period.
**Credit:** one tonne of CO₂e. The methodology converts verified tree-years at 18 kg CO₂e each and rounds down, so a plot of 5,100 tree-years yields 91 credits (91.8 rounded down) and 91 serials. One serial always means one tonne.

| Step | How it works | What stops fraud or double counting |
|---|---|---|
| Register project | An operator registers the programme: name, proponent, boundary hash, ecoregion, methodology and baseline, crediting period, prior land use, additionality statement, tenure and FPIC/validation references. Submissions are linked to it. | A submission cannot name an unknown project, and a project's methodology version must match its submissions. The project, vintage and boundary hash travel with every issuance and certificate. |
| Measure | Farmer walks the plot boundary, records planting, then a survival sample count. Every record is GNSS-stamped and signed on the phone. | Quality score per fix; all three records must carry the same key and farm. |
| Check | The registry re-verifies every hash and signature, then runs automatic checks. | Overlap with any other registered plot, trees per hectare, sample size, impossible counts, fixes outside the plot, survival suspiciously perfect. Hard failures are rejected; soft ones go to manual review. |
| Verify | An independent verifier reviews the evidence on the console, checks recent VIIRS fire detections near the plot, and signs approve or reject. | Only keys on the operator's approved list count. A farmer cannot verify their own plot. A flagged submission cannot be approved without a written reason. The signature is stored. The fire check is normalised and signed into the decision, so it cannot be added or changed afterwards. |
| Methodology | Each submission names a methodology version with its own baseline and buffer share, recorded at submit and again at issuance. | An unknown version is refused. An old issuance keeps the factor it was credited under after the methodology changes. |
| Issue | Approval issues a range of unique serial numbers (`PL-NG-00000001`...) and withholds a buffer share from sale. | One issuance per submission. Serials are contiguous and never reused; the buffer is not saleable; the reconcile page checks that issued = sold + available + buffer + reversed. |
| Reverse | An operator cancels unsold serials after fire, clearing or a failed check, with a reason recorded on the log. | Only unsold units can be cancelled. Serial numbers are never reused, and every cancellation appears in reconciliations. |
| Authorise (Article 6) | An issuance is marked domestic or international, with the authority, the reference and whether a corresponding adjustment applies. | International transfer requires a corresponding adjustment, and units already retired domestically cannot be transferred abroad. The certificate carries the fields. |
| Sell | A buyer buys credits first-in-first-out from issued lots. | Sold credits cannot be sold again. Retiring an order records who claimed it and blocks a second claim. |
| Publish | Anyone can trace one serial (`GET /api/registry/serial/PL-NG-…`) or list every retirement (`GET /api/registry/retirements`), without an account. | A serial resolves to exactly one state (available, sold, buffer, cancelled), with its project, vintage and authorisation. The certificate carries the claim statement and its limits. |
| Pay | Each sale is split in whole kobo (largest remainder, always sums exactly) and payouts go to farmers in proportion to their credits. | One payout number per farmer key. Changing the number holds payouts for 72 hours. A first payout is capped at ₦20,000 with the rest held. Invalid numbers hold the money. Idempotency keys prevent paying twice. |
| Audit | Every state change is an event on a hash-chained log. Anyone can download it and re-verify it in a browser. | Editing any past event breaks the chain from that point; the server refuses to start on a damaged log. Phone numbers are not on the log, only a salted hash and a masked form. |

**Who creates value, verifies, pays, and how revenue grows:** farmers create it by planting and keeping trees alive; independent verifiers confirm it and are paid a share of each sale; buyers pay; the platform keeps a share and routes the rest to farmers and a community pool. Revenue grows with verified credits sold, so the platform earns more only when more trees are verifiably alive.

**All of the following are demo assumptions, set in `server/methodology.mjs` and none are a registered methodology or legal rule:** two methodology versions (`DEMO-AGROFORESTRY-0`, and the current `-1` with an 18 kg CO2e per tree-year factor, a 10% buffer and a matched-plot baseline id), ₦12,000 per tCO₂e credit, and the 60 / 25 / 5 / 10 split between farmers, community, verifier and platform. Nigeria's benefit-sharing percentages for voluntary projects were not found in published sources, so the split is configurable.

The baseline in v2 is a **label and a factor, not a sampled baseline**. A real dynamic baseline needs matched unenrolled plots and repeated measurement, which this build does not do.

**Simulated:** issuance is a registry entry, not a carbon credit recognised by any standard. Payouts go to a sandbox, not a real mobile-money provider. Real credits need an accredited, NCCC-approved verification body, a recognised methodology and registry, and (for international transfers) the Nigerian authorisation process. Do not present the credits as tradable.

Public routes: market, reconcile, log, project list, serial lookup, retirement ledger, certificates and a farmer's own view by key. Operator routes (project registration, submissions queue, orders, retirement, releases, adding verifiers) need the operator token. Verifier decisions need no token because they must carry a valid signature from an approved key. Orders are operator-only in this build because a real buyer flow would need confirmed payment.

## Satellite NDVI check (Sentinel Hub Statistical API)

`GET /api/registry/ndvi?lat=…&lon=…[&bufferKm=0.5&dateFrom=…&dateTo=…]` (operator/verifier, cached 5 min) returns one of:

- **`status: "ok"`** — NDVI mean / min / max / stDev over the buffer, valid-pixel count, and per-month `periods` buckets so the verifier sees the trend, not just the average (e.g. a canopy that was healthy in the growing season and dropped just before the claim).
- **`status: "stub"`** — no provider configured; the honest placeholder, no network call.
- **`status: "unavailable"`** — with an `error` of `bad_arguments`, `auth_failed`, `bad_request`, `provider_error` or `no_valid_pixels` (e.g. full cloud cover in the window says so, it does not invent a number).

Provider: the Sentinel Hub **Statistical API** (`sentinel-2-l2a`, monthly buckets, cloud cover ≤ 30% by default). It computes NDVI statistics server-side and returns plain JSON — no raster pipeline, no Python sidecar, one authenticated POST, matching the zero-dependency Node backend and the fire-check result shape so verifiers sign both checks uniformly. Config in `.env.example`: `SENTINELHUB_TOKEN` (raw bearer) or `SENTINELHUB_CLIENT_ID` + `SENTINELHUB_CLIENT_SECRET` (OAuth client-credentials, token cached until shortly before expiry); free **Copernicus Data Space Ecosystem** credentials (`COPERNICUS_CLIENT_ID`/`COPERNICUS_CLIENT_SECRET`/`COPERNICUS_TOKEN`) work as aliases and auto-resolve to the CDSE endpoints. A **Google Earth Engine** fallback (`GEE_PROJECT_ID` + `GEE_CLIENT_EMAIL` + `GEE_PRIVATE_KEY`, or inline `GEE_SERVICE_ACCOUNT_JSON`) signs a service-account JWT with Node core crypto and asks the Value API for a region NDVI reduce; the expression tree there is hand-built rather than compiled by an EE client library, so it is the supported-fallback path — `NDVI_PROVIDER=gee` forces it, and if EE ever rejects the DAG the endpoint's own error text comes back in `detail`. Alternatives considered and documented in `server/ndvi.mjs`: Microsoft Planetary Computer (Python-native pixel pipeline, better suited to a future heatmap sidecar), carbonplan.org tools (data-architecture reference only, no NDVI computation).

Interpretation guardrails: NDVI is **evidence, not proof** — the same caveats as the fire check apply (cloud, seasonality, sensor noise, and mixed-pixel effects near small plots), and the verifier's signed decision is still what counts.

## Rainfall per plot (CHIRPS daily via Google Earth Engine)

`POST /api/registry/rain` `{"polygon": [{lat, lon}, …], "months": 6}` (farmer-facing — no operator token; the walked boundary is validated and capped at 20 ha, responses cached 6 h, rate-limited) returns one of:

- **`status: "ok"`** — `series` (fixed-width 7-day buckets for the bar chart), `monthly` (calendar months), `totalMm`, `last30Mm`, `lastRainTs`, `longestDrySpellDays/EndedTs` (a day under 2 mm counts as dry), computed in server JS from one CHIRPS daily record per day.
- **`status: "stub"`** — no GEE credentials configured; the honest placeholder, no network call.
- **`status: "unavailable"`** — `auth_failed` / `bad_request` / `provider_error` with EE's own message in `detail`, or `no_valid_pixels` when the window sits past the product's coverage (gaps stay absent, never zeros — CHIRPS final lands with a lag of a few weeks).

Provider: the **Google Earth Engine Value API** (`UCSB-CHG/CHIRPS/DAILY`, ~5 km pixels back to 1981 — every beachhead plot has a record without a rain gauge). One `value:compute` call: `ImageCollection.toBands()` turns each day into a band, `Reducer.mean` reduces every band independently, and the walked polygon is handed to `GeometryConstructors.Polygon` so a 0.5 ha plot is served by one request with no raster pipeline. The DAG is hand-built against the live serialization format (`server/ee.mjs`); the GEE path is the only provider pool CHIRPS lives in, so there is no Copernicus alternative here. Same env as the NDVI GEE fallback (`GEE_*`), so the deployed platform needs those env vars set before rainfall goes live.

Interpretation guardrails: satellite rainfall is **not a gauge on the plot** — 5 km pixels cannot resolve the thunderstorm that hit one farm and skipped its neighbour. It is evidence for planting timing and dry-spell awareness (the farmer panel says so), never a forecast and never a verification gate.

## Deploying to Vercel

The repo ships a `vercel.json` that keeps the single Node handler intact:

- **Static surfaces** (landing, app, console, pitch deck, service worker, vendored Leaflet) are staged by `scripts/vercel-stage.mjs` into `public/` and served by Vercel's static layer — only tracked files ship, so local-only material never goes public.
- **Every `/api/*` route** is served by one serverless function, `api/app.mjs`, which reuses the exact `createApp` request handler from `server/server.mjs`. Same routing logic locally and on the platform; no framework, no rewrite of the brain.
- Headers on static responses replicate the server's security headers (CSP, nosniff, frame-deny, no-cache for the service worker and manifest).
- The demo registry state lives in files under `/tmp` of one instance: it survives requests, not platform recycles. Farmer phones keep their records locally, so the app itself is unaffected; re-provision verifiers after a recycle reboots the tenant. Pointing `DATABASE_URL` at Neon mirrors accounts and sessions to Postgres as usual.

Setup: import the repo at `vercel.com/new`. No paths or framework questions — the config file decides. Optional environment variables (all served from `.env.example` locally): `ADMIN_PASSWORD` (so the operator console keeps one password across recycles), `DATABASE_URL` (Neon Postgres mirror), `ANCHOR_API_KEY` (facility for publishing ledger heads), `COPERNICUS_CLIENT_ID`/`COPERNICUS_CLIENT_SECRET` or `SENTINELHUB_*` (NDVI live), `OPENAI_API_KEY`/`GEMINI_API_KEY` (photo classification), `NEON_REALTIME_SECRET` (console live feed), `REDIS_URL` (leave unset — the function runs uncached).

## Limits to be honest about

- **Self-reported survival counts are sampled, not measured.** The registry catches inconsistent or implausible counts and double registration, but an honest-looking false count still needs the verifier's judgment or a site visit. Random re-inspection would be a further control.
- **Overlap detection compares registered plots by grid sampling.** It will not catch land registered under a slightly different boundary beyond the thresholds, or boundaries drawn wrongly on purpose.
- **GNSS from a browser is a plausibility check, not proof.** Browsers expose position and accuracy only, not raw satellite data or a mock-location flag. The quality score checks accuracy, impossible jumps, clock drift, round coordinates and the farm boundary. A determined spoofer can defeat it. A native Android build with raw GNSS measurements would be stronger.
- **The ledger is tamper-evident, and becomes immutable only when its head is published somewhere the operator cannot edit** (a blockchain memo, a public post). That step is not built. Anchoring the head on Solana is the natural next one.
- **The anchor endpoint is unauthenticated** (limited to 30 writes/min per IP). Production needs authentication and quotas.
- **The signing key lives in the browser's local storage.** Clearing site data loses it; there is no key backup yet. Exports contain the public key only.
- **Reversals only reach unsold credits.** Once a credit is sold or retired, the registry refuses to cancel it rather than clawing it back; a real system needs buffer retirement, replacement units and a dispute process. There are also no monitoring-period renewals: the vintage is the year the submission was received, not a re-measured period.
- **The tonne conversion is a placeholder.** 18 kg CO₂e per verified tree-year is a demo factor, not measured biomass. A real project needs allometric equations, wood density and root:shoot defaults (IPCC, Chave 2014), a sampled baseline and periodic re-measurement.
- **Article 6 fields are records, not authorisations.** They state what an operator entered; they do not constitute host-country authorisation or a corresponding adjustment. Confirm the NCCC process before relying on them.
- **The fire check is evidence, not proof.** VIIRS detects a 375 m pixel; cloud, small fires and night-time timing can hide or invent activity, and a detection near a plot does not say whose land burned. No detection is not proof that nothing burned. It informs the verifier; it does not gate approval.
- **The NDVI check is evidence, not proof, and only runs when it is configured.** Without `SENTINELHUB_*` keys the endpoint returns the stub status; cloud cover, seasonality and mixed pixels (a 0.5 ha plot inside a 10 m Sentinel-2 pixel) can all distort a value, and a healthy NDVI does not prove the specific claimed trees are alive. It informs the verifier; it does not gate approval.
- **The rainfall record is satellite-derived, gauge-free and gap-prone.** CHIRPS estimates precipitation on ~5 km grid pixels; the final product lands weeks late, so the newest days can be missing (they stay missing rather than reading as dry). Dry-spell counts treat any observed day under 2 mm as dry. It informs planting decisions; it doesn't verify anything.
- Map tiles come from OpenStreetMap, fine for a demo; production use needs your own tile provider. Tiles you have viewed are cached for offline use.
- The Redis cache holds public registry views for a few seconds. It is never a source of truth: writes invalidate it, and the server runs uncached when Redis is absent.
- Not built: multi-device sync, real mobile-money integration.

## Next steps

- Replace the placeholder tree-year factor with measured biomass and a sampled baseline.
- Let a reversal consume buffer credits when sold credits are affected, with replacement and a dispute path.
- Add accredited-verifier records (standard, scope, expiry) instead of a hand-maintained key list.
- Publish the registry log head on Solana so history cannot be rewritten quietly.
- Replace the sandbox payout with a licensed mobile-money partner.
- Move the species and conversion factors to a registered methodology.
