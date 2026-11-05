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

GNSS and the service worker need a secure origin: `localhost` works for testing; real phones need HTTPS.

## What it does

| Tab | Feature |
|---|---|
| Farm | Walk the boundary, mark corner points, get area and perimeter. Fixes worse than 50 m are refused. |
| Farm › Seed & fertiliser | Seed and fertiliser quantities from the walked area. Rates are editable starting points, not recommendations. |
| Scout | Geotagged, signed field reports (pest, disease, water stress, weeds, nutrient, healthy) with a GNSS quality score. |
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

## Climate layer: verified tree-years to payouts (Access Youth Tech Forge, Theme 2)

**Climate activity:** farmer-managed agroforestry (trees planted and kept alive on smallholdings).
**Unit:** one verified tree-year, meaning one tree shown to be alive for one monitoring period.

| Step | How it works | What stops fraud or double counting |
|---|---|---|
| Measure | Farmer walks the plot boundary, records planting, then a survival sample count. Every record is GNSS-stamped and signed on the phone. | Quality score per fix; all three records must carry the same key and farm. |
| Check | The registry re-verifies every hash and signature, then runs automatic checks. | Overlap with any other registered plot, trees per hectare, sample size, impossible counts, fixes outside the plot, survival suspiciously perfect. Hard failures are rejected; soft ones go to manual review. |
| Verify | An independent verifier reviews the evidence on the console, checks recent VIIRS fire detections near the plot, and signs approve or reject. | Only keys on the operator's approved list count. A farmer cannot verify their own plot. A flagged submission cannot be approved without a written reason. The signature is stored. The fire check is normalised and signed into the decision, so it cannot be added or changed afterwards. |
| Methodology | Each submission names a methodology version with its own baseline and buffer share, recorded at submit and again at issuance. | An unknown version is refused. An old issuance keeps the factor it was credited under after the methodology changes. |
| Issue | Approval issues a range of unique serial numbers (`PL-NG-00000001`...) and withholds a buffer share from sale. | One issuance per submission. Serials are contiguous and never reused; the buffer is not saleable; the reconcile page checks that issued = sold + available + buffer + reversed. |
| Reverse | An operator cancels unsold serials after fire, clearing or a failed check, with a reason recorded on the log. | Only unsold units can be cancelled. Serial numbers are never reused, and every cancellation appears in reconciliations. |
| Authorise (Article 6) | An issuance is marked domestic or international, with the authority, the reference and whether a corresponding adjustment applies. | International transfer requires a corresponding adjustment, and units already retired domestically cannot be transferred abroad. The certificate carries the fields. |
| Sell | A buyer buys units first-in-first-out from issued lots. | Sold units cannot be sold again. Retiring an order records who claimed it and blocks a second claim. |
| Pay | Each sale is split in whole kobo (largest remainder, always sums exactly) and payouts go to farmers in proportion to their units. | One payout number per farmer key. Changing the number holds payouts for 72 hours. A first payout is capped at ₦20,000 with the rest held. Invalid numbers hold the money. Idempotency keys prevent paying twice. |
| Audit | Every state change is an event on a hash-chained log. Anyone can download it and re-verify it in a browser. | Editing any past event breaks the chain from that point; the server refuses to start on a damaged log. Phone numbers are not on the log, only a salted hash and a masked form. |

**Who creates value, verifies, pays, and how revenue grows:** farmers create it by planting and keeping trees alive; independent verifiers confirm it and are paid a share of each sale; buyers pay; the platform keeps a share and routes the rest to farmers and a community pool. Revenue grows with verified units sold, so the platform earns more only when more trees are verifiably alive.

**All of the following are demo assumptions, set in `server/methodology.mjs` and none are a registered methodology or legal rule:** two methodology versions (`DEMO-AGROFORESTRY-0`, and the current `-1` with an 18 kg CO2e per tree-year factor, a 10% buffer and a matched-plot baseline id), ₦300 per unit, and the 60 / 25 / 5 / 10 split between farmers, community, verifier and platform. Nigeria's benefit-sharing percentages for voluntary projects were not found in published sources, so the split is configurable.

The baseline in v2 is a **label and a factor, not a sampled baseline**. A real dynamic baseline needs matched unenrolled plots and repeated measurement, which this build does not do.

**Simulated:** issuance is a registry entry, not a carbon credit recognised by any standard. Payouts go to a sandbox, not a real mobile-money provider. Real credits need an accredited, NCCC-approved verification body, a recognised methodology and registry, and (for international transfers) the Nigerian authorisation process. Do not present the units as tradable credits.

Operator routes (submissions queue, orders, retirement, releases, adding verifiers) need the operator token. Verifier decisions need no token because they must carry a valid signature from an approved key. Orders are operator-only in this build because a real buyer flow would need confirmed payment.

## Limits to be honest about

- **Self-reported survival counts are sampled, not measured.** The registry catches inconsistent or implausible counts and double registration, but an honest-looking false count still needs the verifier's judgment or a site visit. Satellite checks (NDVI or canopy change) and random re-inspection would be the next controls.
- **Overlap detection compares registered plots by grid sampling.** It will not catch land registered under a slightly different boundary beyond the thresholds, or boundaries drawn wrongly on purpose.
- **GNSS from a browser is a plausibility check, not proof.** Browsers expose position and accuracy only, not raw satellite data or a mock-location flag. The quality score checks accuracy, impossible jumps, clock drift, round coordinates and the farm boundary. A determined spoofer can defeat it. A native Android build with raw GNSS measurements would be stronger.
- **The ledger is tamper-evident, and becomes immutable only when its head is published somewhere the operator cannot edit** (a blockchain memo, a public post). That step is not built. Anchoring the head on Solana is the natural next one.
- **The anchor endpoint is unauthenticated** (limited to 30 writes/min per IP). Production needs authentication and quotas.
- **The signing key lives in the browser's local storage.** Clearing site data loses it; there is no key backup yet. Exports contain the public key only.
- **Reversals only reach unsold units.** Once a unit is sold or retired, the registry refuses to cancel it rather than clawing it back; a real system needs buffer retirement, replacement units and a dispute process. There are also no monitoring-period renewals, so a unit is not yet tied to a vintage year.
- **Article 6 fields are records, not authorisations.** They state what an operator entered; they do not constitute host-country authorisation or a corresponding adjustment. Confirm the NCCC process before relying on them.
- **The fire check is evidence, not proof.** VIIRS detects a 375 m pixel; cloud, small fires and night-time timing can hide or invent activity, and a detection near a plot does not say whose land burned. No detection is not proof that nothing burned. It informs the verifier; it does not gate approval.
- Map tiles come from OpenStreetMap, fine for a demo; production use needs your own tile provider. Tiles you have viewed are cached for offline use.
- The Redis cache holds public registry views for a few seconds. It is never a source of truth: writes invalidate it, and the server runs uncached when Redis is absent.
- Not built: NDVI or other satellite vegetation data, multi-device sync, user accounts, real mobile-money integration.

## Next steps

- Tie each issuance to a monitoring period and vintage, so tree-years are renewed rather than issued once.
- Let a reversal consume buffer units when sold units are affected, with replacement and a dispute path.
- Publish the registry log head on Solana so history cannot be rewritten quietly.
- Replace the sandbox payout with a licensed mobile-money partner.
- Move the species and conversion factors to a registered methodology.
