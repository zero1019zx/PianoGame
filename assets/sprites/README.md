# Piano Balloon Sprite Pack

This folder contains separated game art assets for the piano sight-reading MVP.
All production sprites are PNG files with an alpha channel and are intended for
use in engines such as Unity, Unreal, or an HTML5 canvas renderer.

## Folder Layout

- `raw/`: original chroma-key source images.
- `png/`: full-size RGBA transparent PNGs after chroma-key removal.
- `trimmed/`: alpha-trimmed RGBA transparent PNGs with 24 px safety padding.
- `contact-sheets/`: QA sheets on a checkerboard background.

Use `trimmed/` for game import by default. Keep `png/` if an engine-side sprite
packer needs stable source-canvas dimensions.

## Core Gameplay Sprites

| Asset | Runtime role | Suggested pivot | Interaction / hit area |
| --- | --- | --- | --- |
| `balloon_note_question.png` | Rising note-question balloon | bottom-center at knot | Ellipse around balloon body, exclude string |
| `note_projectile.png` | Fired note projectile | center | Circle around note head plus stem bounds |
| `toy_note_cannon.png` | Launcher prop | bottom-center | Optional tap area: full visual bounds plus 12 px |
| `game_staff_board_double.png` | Upper result score board | center | Non-interactive display layer |
| `note_wrong_red_marker.png` | Gentle wrong-note marker | note-head center | Non-interactive feedback marker |
| `keyboard_reference_strip.png` | Piano-position reference strip | center | Informational; optional key zones created in code |
| `panel_voice_listening.png` | Singing recognition HUD panel | center | Whole panel for help/details; mic zone on left |
| `panel_piano_listening.png` | Piano recognition HUD panel | center | Whole panel for help/details; meter zone in code |

## Home / HUD Sprites

| Asset | Runtime role | Suggested pivot | Interaction / hit area |
| --- | --- | --- | --- |
| `btn_home_sing_card.png` | Home entry: singing mode | center | Full card bounds plus 16 px |
| `btn_home_play_card.png` | Home entry: piano mode | center | Full card bounds plus 16 px |
| `btn_home_calibration_card.png` | Home entry: sound calibration | center | Full card bounds plus 16 px |
| `btn_home_round.png` | Back to home button | center | Circle, min 88 px touch target |
| `btn_replay_round.png` | Replay/listen button | center | Circle, min 88 px touch target |
| `status_pill_ready.png` | Ready status badge | center | Non-interactive unless attached to parent card |
| `status_pill_warning.png` | Needs-calibration badge | center | Non-interactive unless attached to parent card |
| `hud_instruction_card.png` | Top instruction card background | center | Non-interactive display layer |

## Runtime Text

The sprites intentionally avoid baked UI labels where possible. Render these in
engine text layers:

- Mode labels: `唱谱模式`, `弹奏模式`, `声音校准`
- Status labels: `声音就绪`, `中央 C 就绪`, `需要校准`
- Recognition labels: `听到: Mi`, `偏高`, `偏低`, etc.
- HUD values: score, combo, best combo, instructional copy

## Layering Notes

Recommended gameplay render order:

1. Classroom or sky background.
2. `game_staff_board_double`.
3. Already-placed normal score notes rendered by code or separate note sprites.
4. `balloon_note_question`.
5. `note_projectile` and projectile trail/effects.
6. `toy_note_cannon`.
7. Recognition HUD panel and runtime text.
8. Wrong-note marker and temporary feedback glows.

Wrong input should use red as a temporary highlight only. Avoid failure icons,
red X marks, or punitive animations.
