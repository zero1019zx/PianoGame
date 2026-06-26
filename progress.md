Original prompt: 复用该项目的做法，开展下一项目的工作：钢琴识谱启蒙游戏 · MVP 方案（H5 / iPad），包含唱谱/弹谱两种玩法、校准、本地缓存、气球发射音符机制、五线谱归位和节奏回放。

## Progress

- 2026-06-25: Started converting the previous Piano Rush repo into the new notation-learning MVP.
- 2026-06-25: Treating the user-provided MVP方案 as approved product design and implementing a playable H5 shell with replaceable recognition adapters.
- 2026-06-25: Added TDD tests for calibration, hit/miss flow, staff placement, and playback events.
- 2026-06-25: Replaced the rhythm-game UI with a balloon/staff notation MVP interface.
- 2026-06-25: Browser smoke passed and develop-web-game client produced screenshots/state JSON.
- 2026-06-25: Added real Web Audio microphone analysis, environment monitoring, singing template capture, central-C piano calibration, and automatic audio-to-balloon judging.
- 2026-06-25: Upgraded singing recognition from pitch-template fallback to MFCC feature extraction plus DTW sequence matching.

- 2026-06-26: Split the app into three feature entries (唱谱模式 / 弹奏模式 / 声音校准) on a home screen with a lightweight screen router; home shows per-feature 已就绪/需要校准 status pills using the generated card art.
- 2026-06-26: Extracted a shared `src/audioEngine.js` (single mic pipeline, RMS every frame, decimated autocorrelation, throttled MFCC) and a pure, tested `src/calibration.js` state machine.
- 2026-06-26: Built the 声音校准 screen as a full closed loop — mic authorization → guided Do..Si singing capture + central-C piano capture → quality-gated matching/template build → persist to localStorage (read by games) plus an IndexedDB profile snapshot → recorded status written back to the home pills.
- 2026-06-26: Verified with `npm test` (16 pass, incl. new calibration tests) and a jsdom DOM smoke of the home→calibration→record→game flow. Updated `tests/browser-smoke.mjs` for the new navigation (run `npm run smoke` on macOS for the screenshot).

- 2026-06-26: Mobile landscape support — added a portrait "请横屏" overlay (phones / small tablets) and a `@media (orientation: landscape) and (max-height: 500px)` pass that compacts all three screens (smaller type/padding, hide tips & secondary labels) so common phone-landscape sizes (~640–932 × 360–430) fit without overflow; kept 100dvh + safe-area.
- 2026-06-26: UI re-skin with the updated sprite cut-outs — home status pills → cream lozenge to match `status_pill_*`; back/replay round buttons → `btn_home_round` / `btn_replay_round`; game instruction banner → `hud_instruction_card`; 弹奏模式 shows `keyboard_reference_strip`. Game canvas now draws `balloon_note_question` / `toy_note_cannon` / `note_projectile` / `note_wrong_red_marker` via a preloader with procedural fallback (staff stays procedural for exact note placement). Solfège name renders on a soft plate over the balloon so the target stays readable.
- 2026-06-26: Verified — `npm test` 16 pass; jsdom DOM smoke covers home→calibration→record→sing(places notes)→play, plus keyboard-strip toggle and is-sing/is-play classes; all CSS/HTML/JS sprite paths resolve and CSS braces balance. Pixel-level responsive + real mic still need an on-device/browser pass.

- 2026-06-26: Rebuilt the game screens toward mockups 2 & 3. HUD now shows ⭐得分 / ⚡连击 / 🏆最高连击 + a mode badge (唱谱/弹奏); instruction card kept. New live listen panel (DOM/CSS): mic/piano icon, animated waveform, 听到:X box with 准/偏高/偏低, encouragement line; 唱谱 shows the mode label, 弹奏 shows a 低–高 pitch needle driven by live cents. Balloon now shows the target as real **notation** (mini-staff + colored notehead) in a clean window — the 识谱 core — instead of the name. Top board is a cream score board with treble clef; placed notes are colored per syllable with a glow on the latest. Input row is mode-aware: 唱谱 = 7 colored 唱名 buttons Do(C)…Si(B) + a 提示 button (flashes the correct one); 弹奏 = an interactive C–B piano keyboard (with black keys) that highlights the target key and is tappable as a no-mic fallback. Unified 7-note color palette across balloon, board, buttons and keys.
- 2026-06-26: Verified — `npm test` 16 pass; jsdom game smoke covers sing+play placing notes, 提示 flash, keyboard target highlight, mode badges, best-streak; asset paths resolve, CSS balanced.

- 2026-06-26: Fixed sing-calibration stalling on "Do" — the capture needed ~12 MFCC frames (~1.4s continuous), unreachable for a child singing ~1s. Lowered gates (minSamples 5 / 0.7s), added a maxDuration auto-finalize so it can never stall, a live per-syllable progress bar, a 听到/没听到 hint, and a manual 「这个录好了 ➜」 button. Piano capture got the same no-stall timeout.
- 2026-06-26: Per user's choice (strengthen current approach), sing calibration now records **2 takes per syllable** (`SING_TAKES`), aggregated into a template carrying `takes[]`; in-game `matchSingingTemplate` scores against the closest take (min-DTW) and tolerance was loosened (30). Backward compatible with single-`mfccSequence` templates. Calibration UI shows 第N/2遍. Approach confirmed aligned with the goal: per-child voice templates (sing) + per-piano tuning offset (play), stored locally and read back in-game. Known ceiling: lightweight MFCC/DTW can confuse same-vowel name pairs (Do/Sol, Fa/La, Mi/Si).
- 2026-06-26: `npm test` 19 pass (multi-take capture, manual take finalize, no-stall timeout, closest-take matching); jsdom smoke green.

- 2026-06-26: Added a mic diagnostic panel on the calibration screen (🔧 诊断 toggle, fixed bottom-left). Live readout: mic ready, sampleRate, rms (+gate), f0, confidence, mfcc frame id, samples-this-take, phase/take. 「录 5 秒并下载」 records the real mic via MediaRecorder → downloads `calib-debug-audio.*` plus a per-frame `calib-debug-log.json` (t/rms/f0/conf/mfcc/samples), and stashes the last log in localStorage (`notation-debug-last`) for re-download. Purpose: tell apart a silent mic (permission/`file://`) from audio-fine-but-capture-rejecting (threshold/logic). Engine gained `startCapture`/`stopCapture`/`getSampleRate`. Verified: npm test 19 pass + jsdom smoke for the panel.

## TODO

- The `keyboard_reference_strip` slice is now superseded by the interactive CSS keyboard; `panel_voice/piano_listening` slices remain reserved (the live listen panel is DOM/CSS). Wire them as decorative tablet backdrops only if desired.
- Reserved the two `panel_voice_listening` / `panel_piano_listening` HUD slices — wire them as the tablet listen-bar background (overlay live "听到 X" in the baked result box) once positions can be eyeballed on a real screen.

- Next: pixel-polish the two game screens (mockups 2 & 3) — draw the staff board / balloon / cannon / keyboard strip from the PNG sprites instead of procedural canvas shapes.
- On-device: validate real mic capture + DTW thresholds on iPad Safari with actual child voices; add a stronger YIN/CREPE pitch adapter for piano.
- Future: child profile switching UI backed by the IndexedDB snapshot already being written.
