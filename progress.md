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

## TODO

- Next: pixel-polish the two game screens (mockups 2 & 3) — draw the staff board / balloon / cannon / keyboard strip from the PNG sprites instead of procedural canvas shapes.
- On-device: validate real mic capture + DTW thresholds on iPad Safari with actual child voices; add a stronger YIN/CREPE pitch adapter for piano.
- Future: child profile switching UI backed by the IndexedDB snapshot already being written.
