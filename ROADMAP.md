# Plotline — Build Roadmap (v0.2: on-chain integrity)

Status: **planning**. Branch: `feat/onchain`. `main` stays at the stable demo build (`a62fdc0`).

## TL;DR

Two external AI reviews proposed next steps. Verdict:

- **GCF "AI Carbon" → ERC‑1155 "Green AI License Marketplace" (DeepSeek): reject the pivot.** It misread what Plotline is. Keep at most one tiny optional ESG footnote.
- **Solana "blockchain super‑app" (Grok): well‑grounded but over‑reaches.** Take exactly one gem — *anchor the ledger head on‑chain* — and defer the tokenised‑credit / derivatives / DAO scope, which contradicts Plotline's core positioning.

**Guiding principle: anchor proofs, don't tokenise the asset.** Lead with verifiability and honesty (the moat); add tradability only behind real accreditation.

---

## 1. Analysis of the two proposals

### 1a. GCF AI Carbon Checklist → "Green AI License Marketplace" — reject

- The GCF checklist measures the carbon footprint of **AI systems and data centres** (PUE, WUE, INT8 quantisation, GPU lifecycle, renewable %). Plotline is **agroforestry MRV for Nigerian smallholders** — a different domain entirely.
- The proposal pattern‑matched the word "plotline" to a generic ERC‑1155 token project and invented a marketplace for *AI‑model sustainability licenses*. That is a different product, not an upgrade to this one. There is no shared data model, user, or value chain.
- **Only real touch‑point:** Plotline itself calls vision models (field‑photo classification) and satellite APIs. We *could* self‑score Plotline on the GCF checklist as an ESG/governance disclosure — our tooling is already low‑carbon by design (offline‑first, zero‑dependency, CPU‑only, minimal data transfer). That is a nice‑to‑have honesty footnote, **not** a pivot. → Optional, low priority.

**Value to Plotline: near zero as a product direction; marginal as a one‑page self‑disclosure.**

### 1b. Solana "blockchain super‑app" roadmap — mine the gem, resist the rest

Well‑contextualised: it clearly read the real architecture (offline‑first, device ECDSA P‑256 keys, Merkle‑sealed records, hash‑chained ledger, planned Solana head anchoring, GNSS scoring, VIIRS/NDVI/CHIRPS, 60/25/5/10 splits).

**Take now:**

- **Anchor the ledger head on‑chain.** Our own README already names this as the missing piece that turns the hash‑chained log from tamper‑*evident* into tamper‑*proof*: *"becomes immutable only when its head is published somewhere the operator cannot edit … Anchoring the head on Solana is the natural next one."* It is the honest version of "going on‑chain" — publish the head hash where the operator can't edit it, keep farmer records private. Small, contained, completes a property we already advertise.

**Defer / resist (and why):**

- **Minting serials as transferable Token‑2022 / compressed NFTs.** Directly contradicts our stated, defensible honesty: *"issuance is a registry entry, not a carbon credit recognised by any standard … Do not present the credits as tradable."* Tokenising unaccredited credits in front of bankers, climate experts, and a 2029 Nigerian ETS is a credibility and legal landmine. Anchor proofs; don't mint tradable assets until accreditation exists.
- **Parametric / abstract futures (drought, yield, pest derivatives).** Large regulatory + product scope; turns a farmer‑trust MRV tool into a speculation venue; unclear farmer benefit at this stage. Park it.
- **DAO governance, verifier staking/slashing, DID reputation.** Premature — v3 concerns once the core is accredited and live.
- **The core tension:** the proposal itself warns "never force wallets on farmers," yet most of its roadmap pulls toward wallets and tokens. Our moat is the opposite — offline‑first, no‑wallet‑for‑farmers, radical honesty. Keep it.

**Value to Plotline: one genuinely high‑value next step, plus a useful map of what *not* to build yet.**

---

## 2. The real next‑build path

Plotline's own README "Next steps" + "Limits to be honest about" are already a better‑prioritised backlog than either AI gave us, because they are honest about what is simulated. Lead with trust and measurement, not tradability.

### Phase 1 — Make the ledger truly immutable (the gem) · smallest, highest integrity
- Periodically publish the registry log **head hash** to a public, operator‑uneditable target (Solana memo is the planned target; any public, append‑only surface works).
- **Public verifier:** check the local hash‑chain against the anchored head; surface "last anchored at height / tx" in the reconcile and log views.
- Harden the anchor endpoint: make `ANCHOR_API_KEY` auth the **default** (not optional), keep per‑IP quotas.
- *Deliverable:* anyone can verify the registry's history wasn't rewritten, against an external source — an honest "on‑chain" story with no tokens.

### Phase 2 — Verification & key integrity · closes real honesty gaps
- ✅ **Accredited‑verifier records (standard, scope, expiry) are now logged, replayable chain events** (`verifier_accredited` / `verifier_revoked`), replacing the hand‑maintained `verifiers-accred.json` side file. Accreditation history rides the same tamper‑evident, Solana‑anchorable ledger as issuances; `decide()` rejects a revoked verifier; legacy side files still seed at boot for back‑compat. *(done on `feat/onchain`)*
- ⏳ Reversal **consumes buffer** credits when unsold/held units are affected — *already built*. Remaining: a **buyer dispute / replacement path** that can reach *sold* credits (today `reverse()` refuses them and points to this process).
- ⏳ Device signing‑key **backup / recovery** (today localStorage‑only; clearing site data loses the farmer's identity — a real risk, flagged in README limits). Design branches on threat model (passphrase‑encrypted export vs recovery phrase vs operator‑assisted rebind) — decide before building, since it touches the offline‑first, self‑custody client.

### Phase 3 — Credible measurement · what climate experts will probe
- Replace the 18 kg/tree‑year placeholder with allometric biomass (IPCC / Chave 2014, wood density, root:shoot) + a **sampled baseline**; versioned, registrable methodology.
- This is what turns "simulated" into "accreditable."

### Phase 4 — Rails to real money & recognised credits · partner‑gated
- Replace the sandbox payout with a **licensed mobile‑money partner**.
- Pursue an NCCC‑approved verification body + recognised registry/methodology. Only **then** consider real transferability — through the accredited registry, not a bespoke NFT.

### Optional / parallel
- A GCF self‑assessment page scoring Plotline's own compute footprint — an on‑brand honesty artifact (see §1a).

---

## 3. Where blockchain genuinely fits

**Anchoring and public verifiability — not tokenisation.** That keeps the Solana piece honest, cheap, and aligned with the pitch's own line: *"a registry you can audit without trusting us."*

## 4. Sequencing

Phase 1 is the first unit of work on this branch. Phases 2–4 can each branch off `main` as they land. Keep the client dead‑simple and offline‑first throughout; never force wallets on farmers for basic use.
