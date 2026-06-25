# 2026-06-25 Notation MVP Build Log

## Requested Work

- Reuse the previous project approach for a new H5/iPad game.
- Build the “钢琴识谱启蒙游戏” MVP from the provided product plan.
- Keep planning, tests, browser verification, and work logs in the repo.

## Design Decision

- The provided plan is detailed enough to act as the approved design.
- Real speech / pitch recognition is represented by replaceable adapters and child-friendly simulated inputs in this MVP shell.
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

## Verification Notes

- Unit tests: `npm test`
- Browser smoke: `npm run smoke`
- Visual artifacts:
  - `.logs/notation-mvp-smoke.png`
  - `.logs/web-game-client/shot-0.png`
  - `.logs/web-game-client/shot-1.png`
