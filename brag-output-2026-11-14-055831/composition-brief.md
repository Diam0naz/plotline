# Hyperframes Composition Brief: Plotline

## Objective
A short, polished launch-style brag video for Plotline — a premium climate-fintech product film with a human spine.

## Output
- Composition directory: `brag-output-2026-11-14-055831/composition/`
- Rendered video: `brag-output-2026-11-14-055831/brag.mp4`
- Format: landscape — 1920x1080
- Duration: ~23s (VO-timed within 15–25s)

## Source Material
- Project root: `/home/user/Documents/BackEnd_projects/plotline`
- Primary files read: `README.md`, `app.html` structure, `demo-video/composition/index.html` (working reference), `pitch-deck.html`
- Product name: Plotline
- Tagline / strongest claim: "Proven climate work, paid to the farmer." / "Money moves on evidence."
- Key UI/visual to recreate: walked-plot boundary SVG, verifier NDVI trend, public serial certificate, phone payout — all real product views
- Copy that must appear verbatim (grounded in the project):
  - "636 tree-years" (README: verified tree-years; 18 kg/tree-year methodology)
  - "PL-NG-00000001" (README serial format)
  - "₦7,200" + "60% to farmer" (README split 60/25/5/10 at ₦12,000/credit)
  - "no network at all" / offline (README: offline-first)
  - "issuance & payouts simulated pending accreditation" (README honesty)

## Creative Direction
- Tone preset: polished
- Creative direction: earthy, optimistic, premium, data-rich; human spine
- Interpretation: fewer scenes, longer holds, springy-but-purposeful motion; depth and glow carry richness, not clutter
- Angle: unpaid work → provable work → paid work, through one farmer (Amina, 212 Faidherbia trees near Zaria)
- Hook: count-up 0 → 636 tree-years over a satellite plot, then "paid nothing"
- Outro / punchline: logo + "Proven climate work, paid to the farmer."
- Avoid: generic SaaS language; abstract filler; climate clichés (ice, smokestacks); any unverified claim

## Visual Identity
- Background: `#141612` deepened to a satellite-terrain field (built in CSS/SVG — no fetched photos, for licensing safety and determinism)
- Text: `#f5f6f3`
- Accent (veg/data): `#9dbb80` / `#7FB800`; money gold `#d9a54f`/`#E8B04B`; earth `#B5651D`; data blue `#2E6F9E`
- Display font: Space Grotesk + Fraunces (headline); Body/mono: Inter + Roboto Mono
- Visual references: the project's SVG plot, NDVI line, white product cards, hash-chain chips

## Three-plane depth (explicit user request)
Every scene composes in three parallax planes that drift at different rates:
- **Background plane** — satellite-terrain gradient field + grid + slow zoom/drift (farthest, most blur).
- **Midground plane** — the content: cards, plot SVG, big numbers, captions.
- **Foreground plane** — glow orbs, vignette, fine grain, light sweeps (nearest, moves most).
Parallax is driven by scene-level transforms, not mouse (deterministic). Keep it subtle (8–40px offsets).

## Motion language (explicit user request)
- Springy/bouncy entrances: `back.out(1.7–2.4)` and `elastic.out` for pops, counters, logo.
- Lights/glows: radial glow layers behind hero elements; scripted glow-pulse tweens (no audio-reactive extraction available here — document and skip audio-reactive).
- Bold text: large display weights; the hero number is the biggest element on screen.
- Captions: a synced lower-third caption band, one VO line per scene, with the key phrase emphasized; must hold long enough to read (≥0.8s short, ≥0.3s/word sentences).

## Storyboard
Use `brag-output-2026-11-14-055831/brag-plan.md` as the creative contract.

Scene summary:
1. Hook — 6.0s — counter 0→636 tree-years over satellite plot, then "paid nothing"
2. Thesis — 3.5s — "Money moves on evidence." + "turns trees into proof"
3. Chain — 6.5s — walk (offline) → verify (NDVI + signed) → issue (serial PL-NG-00000001)
4. Wow — 4.0s — public certificate resolves, "no login — anyone can check"
5. Paid — 3.5s — phone wallet, ₦7,200 / 60% to farmer, "Paid to Amina"
6. Close — 3.0s — logo + "Proven climate work, paid to the farmer." + honesty chip

## Audio
- Audio role: warm low cinematic bed under a single narrator voiceover
- Audio arc: intimate → thesis → mechanism → payoff → warm close; one swell into the logo
- Music: `assets/music/bed.mp3` (reused), volume ~0.10, fade-in 0.6s, fade-out 2.5s
- Music treatment: duck to ~0.05 under each VO clip, return between
- Music cue guidance: VO-led; cues secondary; soft swell into logo
- Audio-reactive treatment: none — no extraction helper/ffmpeg audio-data path available; glow pulses scripted instead (documented)
- Audio-coupled moments:
  - Scene 1 — counter count-up
  - Scene 3 — corner pops + serial stamp
  - Scene 5 — payout landing
- Voiceover: 5 clips in `assets/vo/01..05.mp3` on their own track(s); music ducks under them.
  - NOTE: VO generation requires user approval (ElevenLabs key via `.env.local`, or local Kokoro). Until then the composition renders with captions + music; VO `<audio>` tags are added and the scenes re-timed to the measured clip lengths once generated.
- Audio files: music already copied to `composition/assets/music/`; VO into `composition/assets/vo/`

## Hyperframes Instructions
Follow the repo's `demo-video/composition/CLAUDE.md` contract: one paused root timeline registered on `window.__timelines["composition-id"]`; every timed element has `data-start` + duration and `class="clip"`; GSAP 3.x from CDN; deterministic only (no Date.now/Math.random/network). Pin `hyperframes@0.9.39` as the existing project does. Run `npx hyperframes check` as the single gate before render. Keep creation and rendering local.
