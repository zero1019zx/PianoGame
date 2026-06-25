# 2026-06-25 Notation MVP Build Log

## Requested Work

- Reuse the previous project approach for a new H5/iPad game.
- Build the “钢琴识谱启蒙游戏” MVP from the provided product plan.
- Keep planning, tests, browser verification, and work logs in the repo.

## Design Decision

- The provided plan is detailed enough to act as the approved design.
- The MVP now includes a real Web Audio microphone path. It uses lightweight pitch/template matching today and keeps manual buttons as a child-friendly fallback and automated-test path.
- The product flow still includes microphone permission, singing calibration, central-C piano calibration, local cached calibration, reset controls, balloon hit feedback, staff placement, and rhythm playback.

## Progress

- Replaced the previous Piano Rush plan with the new notation MVP plan.
- Added `progress.md` for the web-game development loop.
- Added TDD coverage for separate calibration states, correct hit placement, gentle mistakes, and playback event generation.
- Implemented `src/notationGame.js` as the pure game-state module.
- Implemented `src/storage.js` for local calibration storage.
- Rebuilt `index.html`, `styles.css`, and `src/main.js` for the iPad landscape H5 experience.
- Updated the browser smoke test for the new flow and screenshot artifact.
- Ran the develop-web-game Playwright client through `.logs/web_game_playwright_client.js` with screenshots and state JSON under `.logs/web-game-client/`.
- Added `src/audioAnalysis.js` with tested frequency/MIDI conversion, environment classification, singing-template matching, and pitch-target matching.
- Added a real Web Audio microphone pipeline in `src/main.js`: getUserMedia, AnalyserNode time-domain samples, lightweight autocorrelation pitch detection, live environment meter, singing calibration templates, central-C piano calibration, and automatic current-balloon judging.
- Updated the UI toward the attached calibration reference: syllable cards, waveform chips, environment monitor, detected note/cents readout, and central-C gauge.
- Upgraded singing recognition to true MFCC feature extraction plus DTW sequence matching. The old pitch-template path remains only as a fallback when no MFCC template is present.

## Verification Notes

- Unit tests: `npm test`
- Browser smoke: `npm run smoke`
- Visual artifacts:
  - `.logs/notation-mvp-smoke.png`
  - `.logs/web-game-client/shot-0.png`
  - `.logs/web-game-client/shot-1.png`
