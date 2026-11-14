# Brag Plan: Plotline

## What is this app?
An offline-first phone app that turns the trees a Nigerian smallholder keeps alive into verified, traceable carbon credits — and pays her for every tree-year, straight to her phone.

## The angle
One farmer, one hard number, one promise kept in public. Amina kept 212 trees alive for three years — 636 tree-years of real climate work — and was paid nothing. Plotline makes that work *provable*: walked offline, verified against satellite data, issued as a credit anyone can trace with no login, and paid back to her. The video's spine is **unpaid work → provable work → paid work**, told like a quiet premium product film.

## Hook (first 2-3 seconds)
A full-frame count-up: **0 → 636 tree-years**, bold, over a satellite plot glowing to life — then the gut-punch line **"paid nothing."** The number earns the next 20 seconds.

## Key moments (the middle)
- The tree-year counter ticking up, then "paid nothing" landing hard.
- "Money moves on evidence" slamming in as the thesis.
- The three-step chain: walked boundary (offline chip) → verifier signs against an NDVI trend → credit issued with a real serial.
- The wow: a public certificate `PL-NG-00000001` resolving with **no login**, and the ₦ payout landing on a phone.

## Outro / punchline
Plotline logo springs in. **"Proven climate work, paid to the farmer."** A quiet honesty chip: *issuance & payouts simulated pending accreditation.*

## User flow worth showing
entry → key action → result, pulled from the real app: **walk the plot boundary (offline)** → **verifier approves against satellite evidence + signs** → **credit issued, traced publicly, paid to the farmer.** This is the centerpiece (scenes 3–5).

## Tone
- Preset: polished
- Creative direction: earthy, premium climate-fintech product film with a human spine
- Interpretation: fewer scenes, longer holds, confident restraint; motion is springy but purposeful; glow and depth do the richness, not clutter.

## Format: landscape — 1920x1080
## Duration: ~23s (VO-timed within the 15–25s window)

## Visual identity (from the project + user direction)
- Background: `#141612` (project `--ground`) deepened with a satellite-terrain field
- Accent (data/veg): `#9dbb80` / NDVI green `#7FB800`
- Money/gold: `#d9a54f` (project `--gold`) → harvest gold `#E8B04B`
- Earth: laterite ochre `#B5651D`; satellite data blue `#2E6F9E`
- Text: `#f5f6f3`
- Display font: Space Grotesk (project) + Fraunces for the human headline
- Body/mono: Inter + Roboto Mono (project)
- Strongest visual element: the walked-plot SVG + verifier NDVI trend + public serial certificate (all real product views)

## Share copy (draft)
She kept 212 trees alive and was paid nothing. Plotline turns verified tree-years into carbon credits anyone can trace — and pays the farmer. 🌳

## Audio direction
- Role: warm, low cinematic bed under a single narrator voice (voiceover), with sparse springy accents on reveals.
- Music: `assets/music/bed.mp3` (reused project bed), low (~0.10), fade-in 0.6s, fade-out 2.5s, ducked under VO.
- Music treatment: ducks to ~0.05 under each VO clip, returns between.
- Music cue guidance: detect at composition time if needed; the edit is VO-led, so cues are secondary — hold a soft swell into the logo at the end.
- Audio-reactive treatment: none (no extraction helper / ffmpeg audio-data path available here); glow pulses are scripted instead, documented in the brief.
- SFX posture: sparse; soft "tick" feel carried by spring motion, no literal SFX files required.
- Audio-coupled moments: hook counter count-up; three-step chain reveals; serial resolve; payout landing.
- Restraint rule: audio never overpowers the VO; no busy percussion, no waveform visuals.

## Voiceover script
(Voice: warm narrator — ElevenLabs "George" via the repo's tooling, or Kokoro `af_heart`. Generated into `assets/vo/01..05.mp3`.)
1. "Amina kept two hundred and twelve trees alive for three years. Six hundred and thirty-six tree-years of climate work, and she was paid nothing."
2. "Money moves on evidence. So Plotline turns her living trees into proof."
3. "She walks the plot offline. An independent verifier signs it against satellite data. A credit is issued."
4. "Anyone can trace that credit, with no login, and the payment lands on her phone."
5. "Plotline. Proven climate work, paid to the farmer."

## Storyboard

### Scene 1 — Hook: 636 tree-years, paid nothing — 6.0s
Satellite plot glows in (bg plane, slow zoom). Big bold counter **0 → 636** ticks up (mid plane), label "tree-years kept alive". Then **"paid nothing"** slams in gold-to-white. Caption band shows VO line 1.
Sequential/interaction: yes — number counts up, then the "paid nothing" line lands.
Audio intent: intimate, a held breath; VO line 1.
Audio-coupled idea: counter count-up.
Transition mood: soft crossfade → Scene 2

### Scene 2 — Thesis: money moves on evidence — 3.5s
Near-black. **"Money moves on evidence."** springs in, bold. Sub: "Plotline turns trees into proof." Foreground glow sweep.
Sequential/interaction: none.
Audio intent: thesis beat; VO line 2.
Transition mood: clean → Scene 3

### Scene 3 — The chain (walk → verify → issue) — 6.5s
Split: walked-plot SVG (corners pop, boundary draws, "offline" chip) on one plane; verifier card with NDVI trend line + "signed" on another. Three step-labels reveal in order: Walk · Verify · Issue. Credit serial `PL-NG-00000001` stamps in.
Sequential/interaction: yes — 4 plot corners pop one by one, boundary fills, NDVI line draws, serial stamps.
Audio intent: the mechanism working; VO line 3.
Audio-coupled idea: corner pops + serial stamp.
Transition mood: soft slide → Scene 4

### Scene 4 — The wow: public trace — 4.0s
A public certificate card resolves: serial `PL-NG-00000001`, project, vintage, verifier signature, status **available→sold**. Badge **"no login — anyone can check"**.
Sequential/interaction: yes — fields resolve one by one, status flips.
Audio intent: the payoff of trust; VO line 4a.
Transition mood: clean → Scene 5

### Scene 5 — Paid to her phone — 3.5s
A phone wallet card: gold particles stream in, **₦7,200 / credit → 60% to farmer**, "Paid to Amina" toast. Small split chips 60/25/5/10.
Sequential/interaction: yes — gold particles land, amount counts up, toast pops.
Audio intent: warm resolution; VO line 4b.
Audio-coupled idea: payout landing.
Transition mood: soft crossfade → Scene 6

### Scene 6 — Logo + close — 3.0s
Plotline logo springs in (bounce). **"Proven climate work, paid to the farmer."** Honesty chip: *issuance & payouts simulated pending accreditation.* Music swells, fades.
Sequential/interaction: none.
Audio intent: confident close; VO line 5.
Transition mood: end.

**Music mood for this video:** cinematic-warm, low and supportive.
**Audio summary:** A low warm bed carries a single narrator through unpaid → provable → paid, ducking under each line and swelling once into the logo.
