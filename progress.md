Original prompt: 复用该项目的做法，开展下一项目的工作：钢琴识谱启蒙游戏 · MVP 方案（H5 / iPad），包含唱谱/弹谱两种玩法、校准、本地缓存、气球发射音符机制、五线谱归位和节奏回放。

## Progress

- 2026-06-25: Started converting the previous Piano Rush repo into the new notation-learning MVP.
- 2026-06-25: Treating the user-provided MVP方案 as approved product design and implementing a playable H5 shell with replaceable recognition adapters.
- 2026-06-25: Added TDD tests for calibration, hit/miss flow, staff placement, and playback events.
- 2026-06-25: Replaced the rhythm-game UI with a balloon/staff notation MVP interface.
- 2026-06-25: Browser smoke passed and develop-web-game client produced screenshots/state JSON.
- 2026-06-25: Added real Web Audio microphone analysis, environment monitoring, singing template capture, central-C piano calibration, and automatic audio-to-balloon judging.
- 2026-06-25: Upgraded singing recognition from pitch-template fallback to MFCC feature extraction plus DTW sequence matching.

## TODO

- Future: tune MFCC/DTW thresholds with real child-voice recordings and add a stronger YIN/CREPE pitch adapter for piano.
- Future: add child profile switching UI backed by IndexedDB.
