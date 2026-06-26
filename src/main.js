import {
  centsBetween,
  matchDetectedPitch,
  matchSingingTemplate,
  midiToFrequency
} from './audioAnalysis.js';
import {
  SOLFEGE,
  createGame,
  getCurrentTarget,
  getPlaybackEvents,
  loadCalibrationState,
  resetCalibration,
  settleBurst,
  staffYForNote,
  submitInput
} from './notationGame.js';
import {
  activeSolfege,
  createPianoSession,
  createSingSession,
  feedPianoFrame,
  feedSingFrame,
  persistPianoCalibration,
  persistSingCalibration
} from './calibration.js';
import { createAudioEngine } from './audioEngine.js';
import {
  createBrowserCalibrationStore,
  openProfileDatabase,
  saveCalibrationProfile
} from './storage.js';

const SOLFEGE_KEYS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SOLFEGE_MIDI = [60, 62, 64, 65, 67, 69, 71];

const engine = createAudioEngine();
const store = createBrowserCalibrationStore();
openProfileDatabase().catch(() => null);

// Preload gameplay sprites; canvas drawing falls back to procedural shapes
// until each image is decoded, so a missing/slow asset never breaks the game.
const SPRITES = {};
for (const name of ['balloon_note_question', 'toy_note_cannon', 'note_projectile', 'note_wrong_red_marker']) {
  const img = new Image();
  img.src = `assets/sprites/png/${name}.png`;
  SPRITES[name] = img;
}
function spriteReady(name) {
  const img = SPRITES[name];
  return Boolean(img && img.complete && img.naturalWidth > 0);
}

// ---------------------------------------------------------------- router ----
const screenEls = Object.fromEntries(
  [...document.querySelectorAll('.screen')].map((el) => [el.dataset.screen, el])
);
let current = 'home';

function go(screen, opts = {}) {
  if (screens[current]?.exit) screens[current].exit();
  for (const [name, el] of Object.entries(screenEls)) {
    el.hidden = name !== screen;
    el.classList.toggle('is-active', name === screen);
  }
  current = screen;
  screens[screen]?.enter?.(opts);
}

document.querySelectorAll('[data-go-home]').forEach((btn) => btn.addEventListener('click', () => go('home')));

// ================================================================ HOME ======
const pills = {
  sing: document.querySelector('#pill-sing'),
  play: document.querySelector('#pill-play'),
  calibration: document.querySelector('#pill-calibration')
};

function setPill(el, ready, readyText) {
  el.textContent = ready ? readyText : '需要校准';
  el.classList.toggle('ready', ready);
  el.classList.toggle('warn', !ready);
}

function refreshHomePills() {
  const singReady = loadCalibrationState(store, 'sing').completed;
  const playReady = loadCalibrationState(store, 'play').completed;
  setPill(pills.sing, singReady, '声音就绪');
  setPill(pills.play, playReady, '中央C就绪');
  setPill(pills.calibration, singReady && playReady, '已校准');
}

document.querySelector('#card-sing').addEventListener('click', () => go('game', { mode: 'sing' }));
document.querySelector('#card-play').addEventListener('click', () => go('game', { mode: 'play' }));
document.querySelector('#card-calibration').addEventListener('click', () => go('calibration'));
document.querySelector('#home-gear').addEventListener('click', () => go('calibration'));

const homeScreen = { enter: refreshHomePills };

// ========================================================= CALIBRATION ======
const calEnvPill = document.querySelector('#cal-env-pill');
const calEnvState = document.querySelector('#cal-env-state');
const calLevel = document.querySelector('#cal-level');
const calSyllables = document.querySelector('#cal-syllables');
const calNeedle = document.querySelector('#cal-needle');
const calCResult = document.querySelector('#cal-c-result');
const calMiniPiano = document.querySelector('#cal-mini-piano');
const calStartBtn = document.querySelector('#cal-start');
const calDoneBtn = document.querySelector('#cal-done');
const calResetBtn = document.querySelector('#cal-reset');

let cal = { phase: 'idle', sing: null, piano: null, lastNeedle: 0 };

['B', 'C', 'D', 'E', 'F'].forEach((key) => {
  const el = document.createElement('div');
  el.className = `mini-key${key === 'C' ? ' is-c' : ''}`;
  el.textContent = key;
  calMiniPiano.append(el);
});

function renderSyllables() {
  const singState = loadCalibrationState(store, 'sing');
  const savedDone = new Set((singState.templates ?? []).filter((t) => t.completed).map((t) => t.solfege));
  const activeIndex = cal.phase === 'sing' ? cal.sing.stepIndex : -1;
  calSyllables.innerHTML = '';
  SOLFEGE.forEach((solfege, index) => {
    const sessionDone = cal.phase === 'sing' && index < cal.sing.stepIndex;
    const done = sessionDone || savedDone.has(solfege);
    const active = index === activeIndex;
    const card = document.createElement('div');
    card.className = `syllable-card syl-n${index + 1}${active ? ' active' : ''}${done ? ' done' : ''}`;
    card.innerHTML = `
      <span class="syl">${solfege}</span>
      <span class="key">(${SOLFEGE_KEYS[index]})</span>
      <svg class="wave" viewBox="0 0 40 14" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 7 Q3 1 6 7 T12 7 T18 7 T24 7 T30 7 T36 7 T42 7" fill="none" stroke="currentColor" stroke-width="2"/>
      </svg>
      <span class="state">${done ? '已识别' : active ? '录音中' : '待录入'}</span>`;
    calSyllables.append(card);
  });
}

function renderNeedle(offsetCents) {
  const clamped = Math.max(-50, Math.min(50, offsetCents));
  calNeedle.style.transform = `translateX(-50%) rotate(${clamped * 0.9}deg)`;
}

function renderPianoResult() {
  const playState = loadCalibrationState(store, 'play');
  if (cal.phase === 'piano') {
    calCResult.textContent = '请弹中央 C，按住别松手…';
    calCResult.classList.remove('good');
  } else if (playState.completed) {
    const offset = playState.centralCOffsetCents ?? 0;
    calCResult.textContent = `音准良好，偏移 ${offset > 0 ? '+' : ''}${offset} cents`;
    calCResult.classList.add('good');
    renderNeedle(offset);
  } else {
    calCResult.textContent = '等待中央 C';
    calCResult.classList.remove('good');
    renderNeedle(0);
  }
}

function setCalHint(text) {
  calEnvState.textContent = text;
}

async function startCalibration() {
  if (!engine.isReady()) {
    calEnvPill.textContent = '正在请求麦克风…';
    const result = await engine.enable();
    if (!result.ok) {
      calEnvPill.textContent = result.reason === 'denied' ? '麦克风被拒绝，请在浏览器允许' : '此设备无法使用麦克风';
      return;
    }
  }
  engine.resetSequence();
  cal = { phase: 'sing', sing: createSingSession(), piano: null, lastNeedle: 0 };
  calStartBtn.querySelector('small').textContent = '请依次唱 Do Re Mi…';
  renderSyllables();
  renderPianoResult();
}

function finishSingPhase() {
  persistSingCalibration(store, cal.sing.templates);
  snapshotProfile();
  cal.phase = 'piano';
  cal.piano = createPianoSession();
  engine.resetSequence();
  renderSyllables();
  renderPianoResult();
}

function finishPianoPhase(result) {
  persistPianoCalibration(store, result);
  snapshotProfile();
  cal.phase = 'done';
  calStartBtn.querySelector('small').textContent = '校准完成，可重新校准';
  renderPianoResult();
}

function snapshotProfile() {
  saveCalibrationProfile({
    sing: loadCalibrationState(store, 'sing'),
    play: loadCalibrationState(store, 'play')
  }).catch(() => null);
}

function calibrationFrame(dt, live) {
  // environment monitor (always live once mic is on)
  calLevel.style.width = `${Math.min(100, Math.round(live.rms * 620))}%`;
  if (engine.isReady()) {
    calEnvPill.textContent = live.environment.label;
    calEnvPill.classList.toggle('good', live.environment.status === 'good');
    calEnvPill.classList.toggle('noisy', live.environment.status === 'noisy');
    const stateLabel = { quiet: '安静 🙂', good: '安静 😄', noisy: '偏吵 😟', listening: '监听中 🙂', idle: '等待 🙂' };
    setCalHint(`当前：${stateLabel[live.environment.status] ?? '监听中 🙂'}`);
  }

  if (cal.phase === 'sing') {
    const { captured, done } = feedSingFrame(cal.sing, live, dt);
    if (captured) {
      engine.playTone(captured.template.midi ?? SOLFEGE_MIDI[captured.stepIndex], 0.16);
      renderSyllables();
    }
    if (done) finishSingPhase();
  } else if (cal.phase === 'piano') {
    if (live.frequency) renderNeedle(centsBetween(midiToFrequency(60), live.frequency));
    const { result, done } = feedPianoFrame(cal.piano, live, dt);
    if (done && result) {
      engine.playTone(60, 0.18);
      finishPianoPhase(result);
    }
  }
}

calStartBtn.addEventListener('click', startCalibration);
calResetBtn.addEventListener('click', () => {
  resetCalibration(store, 'sing');
  resetCalibration(store, 'play');
  saveCalibrationProfile({ sing: null, play: null }).catch(() => null);
  cal = { phase: 'idle', sing: null, piano: null, lastNeedle: 0 };
  calStartBtn.querySelector('small').textContent = '一步步完成校准';
  renderSyllables();
  renderPianoResult();
});
calDoneBtn.addEventListener('click', () => go('home'));

const calibrationScreen = {
  enter() {
    cal = { phase: 'idle', sing: null, piano: null, lastNeedle: 0 };
    calEnvPill.textContent = engine.isReady() ? '麦克风已就绪' : '等待麦克风';
    renderSyllables();
    renderPianoResult();
  },
  frame: calibrationFrame
};

// ================================================================ GAME =======
const canvas = document.querySelector('#game-canvas');
const ctx = canvas.getContext('2d');
const inputArea = document.querySelector('#input-area');
const solfegePad = document.querySelector('#solfege-pad');
const pianoPad = document.querySelector('#piano-pad');
const hintBtn = document.querySelector('#hint-btn');
const scoreEl = document.querySelector('#score');
const streakEl = document.querySelector('#streak');
const bestStreakEl = document.querySelector('#best-streak');
const feedbackEl = document.querySelector('#feedback');
const detectedNote = document.querySelector('#detected-note');
const detectedCents = document.querySelector('#detected-cents');
const hudTitle = document.querySelector('#hud-title');
const hudSub = document.querySelector('#hud-sub');
const modeBadgeName = document.querySelector('#mode-badge-name');
const modeBadgeSub = document.querySelector('#mode-badge-sub');
const listenStatus = document.querySelector('#listen-status');
const listenPanel = document.querySelector('#listen-panel');
const playNeedle = document.querySelector('#play-needle');
const gameMicBtn = document.querySelector('#game-mic');
const replayBtn = document.querySelector('#replay-btn');
const gameScreenEl = document.querySelector('[data-screen="game"]');

const SOLF_COLORS = ['#ef5d52', '#ef8a3b', '#e0a400', '#5bb85f', '#3f8de0', '#9b6cd6', '#e06aa6'];
const MODE_BADGE = {
  sing: { name: '唱谱模式', sub: '说出气球里的音名' },
  play: { name: '弹奏模式', sub: '在钢琴上弹出它' }
};

let mode = 'sing';
let game = createGame({ mode });
let elapsed = 0;
let burstTimer = 0;
let playbackTimer = 0;
let playbackEvents = [];
let nextPlaybackIndex = 0;
let audioJudgeCooldown = 0;
let liveCents = null;
let wrongFlash = 0;
let bestStreak = 0;
let balloonPos = { x: 0, y: 0, rx: 0, ry: 0 };

const HUD_COPY = {
  sing: { title: '请唱出气球里的音符', sub: '唱对后，音符会飞上去填在乐谱上哦！' },
  play: { title: '看气球里的音符，在钢琴上弹出它！', sub: '弹对后，音符会飞上去填在乐谱上哦！' }
};

function startGame(nextMode) {
  mode = nextMode;
  game = createGame({ mode });
  elapsed = 0;
  burstTimer = 0;
  playbackTimer = 0;
  playbackEvents = [];
  nextPlaybackIndex = 0;
  liveCents = null;
  wrongFlash = 0;
  bestStreak = 0;
  hudTitle.textContent = HUD_COPY[mode].title;
  hudSub.textContent = HUD_COPY[mode].sub;
  modeBadgeName.textContent = MODE_BADGE[mode].name;
  modeBadgeSub.textContent = MODE_BADGE[mode].sub;
  listenStatus.textContent = `当前模式：${MODE_BADGE[mode].name}`;
  gameScreenEl.classList.toggle('is-sing', mode === 'sing');
  gameScreenEl.classList.toggle('is-play', mode === 'play');
  renderInputs();
  updateGameHud();
}

function handleInput(option) {
  const payload = mode === 'sing' ? { mode, solfege: option.value } : { mode, midi: option.value };
  const result = submitInput(game, payload);
  if (result.correct) {
    burstTimer = 0.7;
    engine.playTone(result.target.midi, 0.16);
    if (game.phase === 'playback') startPlayback();
    renderInputs();
  } else {
    engine.playTone(48, 0.05);
    wrongFlash = 0.8;
  }
  updateGameHud();
}

function renderInputs() {
  const target = getCurrentTarget(game);
  inputArea.hidden = !target || game.phase === 'playback';
  if (inputArea.hidden) return;
  renderSolfegePad();
  renderPianoKeyboard(target);
}

function renderSolfegePad() {
  solfegePad.innerHTML = '';
  SOLFEGE.forEach((solfege, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'solfege-btn';
    button.dataset.solf = solfege;
    button.style.setProperty('--c', SOLF_COLORS[index]);
    button.innerHTML = `<b>${solfege}</b><small>(${SOLFEGE_KEYS[index]})</small>`;
    button.addEventListener('click', () => handleInput({ value: solfege }));
    solfegePad.append(button);
  });
}

function renderPianoKeyboard(target = getCurrentTarget(game)) {
  pianoPad.innerHTML = '';
  const keys = document.createElement('div');
  keys.className = 'piano-keys';
  SOLFEGE_MIDI.forEach((midi, index) => {
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'wkey';
    key.dataset.midi = String(midi);
    key.style.color = SOLF_COLORS[index];
    key.textContent = SOLFEGE_KEYS[index];
    if (target && target.midi === midi) key.classList.add('target');
    key.addEventListener('click', () => handleInput({ value: midi }));
    keys.append(key);
  });
  for (const after of [0, 1, 3, 4, 5]) {
    const black = document.createElement('span');
    black.className = 'bkey';
    black.style.left = `${(100 * (after + 1)) / 7}%`;
    keys.append(black);
  }
  pianoPad.append(keys);
}

function flashHint() {
  const target = getCurrentTarget(game);
  if (!target) return;
  const el = mode === 'sing'
    ? solfegePad.querySelector(`.solfege-btn[data-solf="${target.solfege}"]`)
    : pianoPad.querySelector(`.wkey[data-midi="${target.midi}"]`);
  if (!el) return;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

function startPlayback() {
  game.phase = 'playback';
  playbackEvents = getPlaybackEvents(game);
  playbackTimer = 0;
  nextPlaybackIndex = 0;
  game.feedback = '全曲回放中';
  renderInputs();
}

function judgeLiveAudio(live) {
  if (!engine.isReady() || audioJudgeCooldown > 0 || game.phase !== 'aiming') return;
  const target = getCurrentTarget(game);
  if (!target || !live.frequency || live.confidence < 0.56 || live.rms < 0.014) return;
  const calibration = loadCalibrationState(store, mode);
  if (!calibration.completed) return;

  if (mode === 'sing') {
    const match = matchSingingTemplate({
      detectedFrequency: live.frequency,
      detectedMfccSequence: live.mfccSequence.slice(-10),
      templates: calibration.templates ?? [],
      toleranceCents: 140,
      tolerance: 24
    });
    liveCents = match.cents ?? null;
    if (match.correct && match.solfege === target.solfege) {
      registerAudioHit(submitInput(game, { mode: 'sing', solfege: target.solfege }));
    } else if (match.correct && match.solfege) {
      submitInput(game, { mode: 'sing', solfege: match.solfege });
      audioJudgeCooldown = 1.1;
      wrongFlash = 0.8;
      updateGameHud();
    }
  } else {
    const match = matchDetectedPitch({
      targetMidi: target.midi,
      detectedFrequency: live.frequency,
      centralCOffsetCents: calibration.centralCOffsetCents,
      toleranceCents: 55
    });
    liveCents = match.cents;
    if (match.correct) {
      registerAudioHit(submitInput(game, { mode: 'play', midi: target.midi }));
    } else if (Math.abs(match.cents) > 90) {
      submitInput(game, { mode: 'play', midi: match.midi });
      audioJudgeCooldown = 1.1;
      wrongFlash = 0.8;
      updateGameHud();
    }
  }
}

function registerAudioHit(result) {
  if (!result.correct) return;
  burstTimer = 0.7;
  audioJudgeCooldown = 0.95;
  engine.playTone(result.target.midi, 0.16);
  if (game.phase === 'playback') startPlayback();
  renderInputs();
  updateGameHud();
}

function gameFrame(dt, live) {
  elapsed += dt;
  audioJudgeCooldown = Math.max(0, audioJudgeCooldown - dt);
  wrongFlash = Math.max(0, wrongFlash - dt);

  if (game.phase === 'burst') {
    burstTimer -= dt;
    if (burstTimer <= 0) {
      settleBurst(game);
      renderInputs();
    }
  }
  if (game.phase === 'playback' && playbackEvents.length > 0) {
    playbackTimer += dt * 1000;
    while (nextPlaybackIndex < playbackEvents.length && playbackTimer >= playbackEvents[nextPlaybackIndex].at) {
      engine.playTone(playbackEvents[nextPlaybackIndex].midi, 0.08);
      nextPlaybackIndex += 1;
    }
    if (nextPlaybackIndex >= playbackEvents.length) game.feedback = '回放完成，可以再玩一次';
  }

  judgeLiveAudio(live);
  draw();
  updateGameHud(live);
}

function updateGameHud(live = engine.getLive()) {
  bestStreak = Math.max(bestStreak, game.streak);
  gameMicBtn.classList.toggle('live', engine.isReady());
  listenPanel.classList.toggle('live', live.rms > 0.02);
  detectedNote.textContent = live.midi ? midiName(live.midi) : '--';
  detectedCents.textContent = Number.isFinite(liveCents)
    ? (Math.abs(liveCents) <= 15 ? '准' : liveCents > 0 ? '偏高' : '偏低')
    : '';
  if (Number.isFinite(liveCents)) {
    playNeedle.style.left = `${Math.max(2, Math.min(98, 50 + liveCents))}%`;
  }
  scoreEl.textContent = String(game.score);
  streakEl.textContent = String(game.streak);
  bestStreakEl.textContent = String(bestStreak);
  feedbackEl.textContent = game.feedback;
}

function midiName(midi) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

// ----- canvas drawing -----
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * ratio));
  const height = Math.max(1, Math.floor(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function draw() {
  resizeCanvas();
  const width = canvas.clientWidth || 1080;
  const height = canvas.clientHeight || 720;
  ctx.clearRect(0, 0, width, height);
  drawStaff(width, height);
  drawPlacedNotes(width, height);
  drawBalloon(width, height);
  drawProjectile(width, height);
  drawLauncher(width, height);
  drawWrongMarker(width, height);
}

function drawSpriteContain(name, cx, cy, maxW, maxH, anchor = 'center') {
  if (!spriteReady(name)) return false;
  const img = SPRITES[name];
  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const x = cx - w / 2;
  const y = anchor === 'bottom' ? cy - h : cy - h / 2;
  ctx.drawImage(img, x, y, w, h);
  return true;
}

function staffTop(height) { return height * 0.085; }
function staffGap(height) { return Math.max(16, height * 0.044); }

function drawStaff(width, height) {
  const x = width * 0.1;
  const staffWidth = width * 0.8;
  const top = staffTop(height);
  const gap = staffGap(height);
  // cream score board
  const bx = x - gap * 2.4;
  const by = top - gap * 1.8;
  const bw = staffWidth + gap * 4.8;
  const bh = gap * 8;
  ctx.fillStyle = 'rgba(251, 243, 221, 0.94)';
  roundedRect(bx, by, bw, bh, gap * 0.9);
  ctx.fill();
  ctx.strokeStyle = 'rgba(225, 205, 160, 0.95)';
  ctx.lineWidth = 3;
  roundedRect(bx, by, bw, bh, gap * 0.9);
  ctx.stroke();
  // treble staff lines
  ctx.strokeStyle = '#46566f';
  ctx.lineWidth = 2;
  for (let line = 0; line < 5; line += 1) {
    const y = top + line * gap;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + staffWidth, y);
    ctx.stroke();
  }
  ctx.font = `900 ${gap * 3.4}px ui-rounded, system-ui`;
  ctx.fillStyle = '#46566f';
  ctx.fillText('𝄞', x - gap * 1.9, top + gap * 3.2);
}

function noteY(height, songNote) {
  const top = staffTop(height);
  const gap = staffGap(height);
  return top + gap * 4 - songNote.staffStep * (gap * 0.5);
}

function drawPlacedNotes(width, height) {
  const startX = width * 0.2;
  const span = width * 0.6;
  const gap = span / Math.max(1, game.song.notes.length - 1);
  game.placedNotes.forEach((songNote, index) => {
    const x = startX + index * gap;
    const y = noteY(height, songNote);
    const color = SOLF_COLORS[SOLFEGE.indexOf(songNote.solfege)] ?? '#3f8de0';
    const latest = index === game.placedNotes.length - 1;
    if (latest) {
      ctx.save();
      ctx.shadowColor = 'rgba(246, 185, 59, 0.9)';
      ctx.shadowBlur = 18;
    }
    drawNoteHead(x, y, staffGap(height), color);
    if (latest) ctx.restore();
    ctx.fillStyle = '#46566f';
    ctx.font = '800 14px ui-rounded, system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(songNote.solfege, x, y + staffGap(height) * 1.9);
    ctx.textAlign = 'start';
  });
}

function drawBalloon(width, height) {
  if (!game.balloon) return;
  const target = getCurrentTarget(game) ?? game.placedNotes.at(-1);
  const bob = Math.sin(elapsed * 2.8) * 10;
  const x = width * 0.6;
  const y = height * 0.52 + bob;
  const rx = Math.min(94, width * 0.088);
  const ry = rx * 1.16;
  const placed = game.balloon.state === 'placed';
  balloonPos = { x, y, rx, ry };

  ctx.save();
  if (placed) ctx.globalAlpha = 0.4;
  const drew = drawSpriteContain('balloon_note_question', x, y, rx * 2.7, ry * 2.6, 'center');
  if (!drew) {
    ctx.fillStyle = placed ? 'rgba(155, 120, 214, 0.3)' : '#9b6cd6';
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#7a4fc0';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath();
    ctx.ellipse(x - rx * 0.32, y - ry * 0.34, rx * 0.22, ry * 0.16, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#b69be0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y + ry);
    ctx.quadraticCurveTo(x - 18, y + ry + 40, x + 8, y + ry + 80);
    ctx.stroke();
  }
  ctx.restore();

  // The target is shown as actual notation (mini-staff + notehead) — this is the 识谱 core.
  if (target) drawBalloonNotation(x, y, rx, ry, target, placed);
}

function drawBalloonNotation(x, y, rx, ry, target, placed) {
  const winW = rx * 1.5;
  const winH = ry * 1.12;
  const mg = winH * 0.17;
  const sw = winW * 0.4;
  ctx.save();
  if (placed) ctx.globalAlpha = 0.5;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
  roundedRect(x - winW / 2, y - winH / 2, winW, winH, winH * 0.16);
  ctx.fill();
  ctx.strokeStyle = 'rgba(43, 58, 79, 0.78)';
  ctx.lineWidth = 1.6;
  for (let k = 0; k < 5; k += 1) {
    const ly = y + (k - 2) * mg;
    ctx.beginPath();
    ctx.moveTo(x - sw, ly);
    ctx.lineTo(x + sw, ly);
    ctx.stroke();
  }
  const noteY2 = y + 2 * mg - target.staffStep * (mg * 0.5);
  const color = SOLF_COLORS[SOLFEGE.indexOf(target.solfege)] ?? '#46566f';
  ctx.save();
  ctx.translate(x, noteY2);
  ctx.rotate(-0.3);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, mg * 0.64, mg * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(x + mg * 0.56, noteY2 - 1);
  ctx.lineTo(x + mg * 0.56, noteY2 - mg * 2.2);
  ctx.stroke();
  ctx.restore();
}

function drawProjectile(width, height) {
  if (game.phase !== 'burst') return;
  const fromX = width * 0.15;
  const fromY = height * 0.8;
  const t = 1 - Math.max(0, Math.min(1, burstTimer / 0.7));
  const x = fromX + (balloonPos.x - fromX) * t;
  const y = fromY + (balloonPos.y - fromY) * t - Math.sin(t * Math.PI) * 64;
  const size = Math.min(72, width * 0.06);
  if (!drawSpriteContain('note_projectile', x, y, size, size, 'center')) {
    drawNoteHead(x, y, staffGap(height), '#ffd25c');
  }
}

function drawLauncher(width, height) {
  const x = width * 0.15;
  const y = height * 0.84;
  const w = Math.min(170, width * 0.18);
  if (drawSpriteContain('toy_note_cannon', x, y, w, w, 'bottom')) return;
  ctx.save();
  ctx.fillStyle = '#3f8de0';
  ctx.strokeStyle = '#2b3a4f';
  ctx.lineWidth = 3;
  ctx.translate(x, y - w * 0.3);
  ctx.rotate(-0.5);
  roundedRect(-26, -30, 96, 60, 16);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawWrongMarker(width, height) {
  if (wrongFlash > 0 && game.balloon) {
    const x = balloonPos.x + balloonPos.rx * 1.05;
    const y = balloonPos.y - balloonPos.ry * 0.55;
    const size = Math.min(64, width * 0.055);
    ctx.save();
    ctx.globalAlpha = Math.min(1, wrongFlash / 0.4);
    if (!drawSpriteContain('note_wrong_red_marker', x, y, size, size, 'center')) {
      ctx.fillStyle = '#ef5d52';
      ctx.font = '900 26px ui-rounded, system-ui';
      ctx.fillText('再试一次', x - 24, y);
    }
    ctx.restore();
  }
  if (game.mistakes.length > 0) {
    ctx.fillStyle = '#b06b54';
    ctx.font = '800 15px ui-rounded, system-ui';
    ctx.fillText(`温柔提示：已经尝试 ${game.mistakes.length} 次`, width * 0.1, height * 0.07);
  }
}

function drawNoteHead(x, y, gap, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.32);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, gap * 0.62, gap * 0.46, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = '#2b3a4f';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x + gap * 0.55, y - gap * 0.3);
  ctx.lineTo(x + gap * 0.55, y - gap * 2.4);
  ctx.stroke();
}

function roundedRect(x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
}

gameMicBtn.addEventListener('click', () => engine.enable());
replayBtn.addEventListener('click', startPlayback);
hintBtn.addEventListener('click', flashHint);

const gameScreen = {
  async enter({ mode: nextMode = 'sing' } = {}) {
    startGame(nextMode);
    draw();
    if (!engine.isReady()) await engine.enable();
  },
  frame: gameFrame
};

// ============================================================== screens =====
const screens = {
  home: homeScreen,
  calibration: calibrationScreen,
  game: gameScreen
};

// ============================================================= main loop ====
function stepFrame(dt) {
  const live = engine.pull(dt);
  screens[current]?.frame?.(dt, live);
}

function tick(now) {
  if (!tick.last) tick.last = now;
  const dt = Math.min(0.05, (now - tick.last) / 1000);
  tick.last = now;
  stepFrame(dt);
  requestAnimationFrame(tick);
}

window.addEventListener('resize', () => { if (current === 'game') draw(); });

// ------------------------------------------------------------- test hooks ---
window.advanceTime = (ms) => {
  const steps = Math.max(1, Math.round(ms / 16.67));
  for (let index = 0; index < steps; index += 1) stepFrame(1 / 60);
};
window.__go = (screen, opts) => go(screen, opts);
window.render_game_to_text = () => JSON.stringify({
  screen: current,
  mode,
  phase: game.phase,
  target: getCurrentTarget(game),
  score: game.score,
  streak: game.streak,
  placedNotes: game.placedNotes.map((n) => ({ id: n.id, solfege: n.solfege, midi: n.midi })),
  mistakes: game.mistakes.length,
  calibration: {
    sing: loadCalibrationState(store, 'sing').completed,
    play: loadCalibrationState(store, 'play').completed
  },
  microphoneReady: engine.isReady(),
  calPhase: cal.phase
});
// Deterministic calibration record for headless smoke tests (no real mic).
window.__demoCalibrate = () => {
  const templates = SOLFEGE.map((solfege, index) => ({
    solfege,
    completed: true,
    midi: SOLFEGE_MIDI[index],
    frequency: midiToFrequency(SOLFEGE_MIDI[index]),
    mfccSequence: [[index, 1, 0.5], [index + 0.1, 1, 0.5]],
    samples: 12
  }));
  persistSingCalibration(store, templates, '小朋友');
  persistPianoCalibration(store, { centralCOffsetCents: 0, referenceMidi: 60, referenceFrequency: midiToFrequency(60) });
  renderSyllables();
  renderPianoResult();
  refreshHomePills();
};

refreshHomePills();
requestAnimationFrame(tick);
