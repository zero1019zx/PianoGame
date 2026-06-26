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
  modeInputOptions,
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
const inputPad = document.querySelector('#input-pad');
const scoreEl = document.querySelector('#score');
const streakEl = document.querySelector('#streak');
const progressEl = document.querySelector('#progress');
const feedbackEl = document.querySelector('#feedback');
const detectedNote = document.querySelector('#detected-note');
const detectedCents = document.querySelector('#detected-cents');
const gameLevel = document.querySelector('#game-level');
const hudTitle = document.querySelector('#hud-title');
const hudSub = document.querySelector('#hud-sub');
const gameMicBtn = document.querySelector('#game-mic');
const replayBtn = document.querySelector('#replay-btn');
const keyboardStrip = document.querySelector('#keyboard-strip');
const gameScreenEl = document.querySelector('[data-screen="game"]');

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
  hudTitle.textContent = HUD_COPY[mode].title;
  hudSub.textContent = HUD_COPY[mode].sub;
  keyboardStrip.hidden = mode !== 'play';
  gameScreenEl.classList.toggle('is-sing', mode === 'sing');
  gameScreenEl.classList.toggle('is-play', mode === 'play');
  renderInputPad();
  updateGameHud();
}

function handleInput(option) {
  const payload = mode === 'sing' ? { mode, solfege: option.value } : { mode, midi: option.value };
  const result = submitInput(game, payload);
  if (result.correct) {
    burstTimer = 0.7;
    engine.playTone(result.target.midi, 0.16);
    if (game.phase === 'playback') startPlayback();
    renderInputPad();
  } else {
    engine.playTone(48, 0.05);
    wrongFlash = 0.8;
  }
  updateGameHud();
}

function renderInputPad() {
  const target = getCurrentTarget(game);
  inputPad.innerHTML = '';
  if (!target || game.phase === 'playback') {
    inputPad.hidden = true;
    return;
  }
  inputPad.hidden = false;
  for (const option of modeInputOptions(mode, target)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option.label;
    button.classList.toggle('correct-hint', option.correct);
    button.addEventListener('click', () => handleInput(option));
    inputPad.append(button);
  }
}

function startPlayback() {
  game.phase = 'playback';
  playbackEvents = getPlaybackEvents(game);
  playbackTimer = 0;
  nextPlaybackIndex = 0;
  game.feedback = '全曲回放中';
  renderInputPad();
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
  renderInputPad();
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
      renderInputPad();
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
  gameMicBtn.classList.toggle('live', engine.isReady());
  gameLevel.style.width = `${Math.min(100, Math.round(live.rms * 620))}%`;
  detectedNote.textContent = live.midi ? midiName(live.midi) : '--';
  detectedCents.textContent = Number.isFinite(liveCents)
    ? `${liveCents > 0 ? '+' : ''}${Math.round(liveCents)} cents`
    : '';
  scoreEl.textContent = String(game.score);
  streakEl.textContent = String(game.streak);
  progressEl.textContent = `${game.placedNotes.length} / ${game.song.notes.length}`;
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

function staffTop(height) { return height * 0.16; }
function staffGap(height) { return Math.max(20, height * 0.05); }

function drawStaff(width, height) {
  const x = width * 0.1;
  const staffWidth = width * 0.8;
  const top = staffTop(height);
  const gap = staffGap(height);
  ctx.strokeStyle = '#3a4a63';
  ctx.lineWidth = 2;
  for (let line = 0; line < 5; line += 1) {
    const y = top + line * gap;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + staffWidth, y);
    ctx.stroke();
  }
  ctx.font = `900 ${gap * 3.2}px ui-rounded, system-ui`;
  ctx.fillStyle = '#3a4a63';
  ctx.fillText('𝄞', x - gap * 1.8, top + gap * 3.1);
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
  for (const [index, songNote] of game.placedNotes.entries()) {
    const x = startX + index * gap;
    drawNoteHead(x, noteY(height, songNote), staffGap(height), '#3f8de0');
    ctx.fillStyle = '#3a4a63';
    ctx.font = '800 15px ui-rounded, system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(songNote.solfege, x, noteY(height, songNote) + staffGap(height) * 1.7);
    ctx.textAlign = 'start';
  }
}

function drawBalloon(width, height) {
  if (!game.balloon) return;
  const target = getCurrentTarget(game) ?? game.placedNotes.at(-1);
  const bob = Math.sin(elapsed * 2.8) * 10;
  const x = width * 0.6;
  const y = height * 0.5 + bob;
  const rx = Math.min(88, width * 0.085);
  const ry = rx * 1.18;
  const placed = game.balloon.state === 'placed';
  balloonPos = { x, y, rx, ry };

  ctx.save();
  if (placed) ctx.globalAlpha = 0.4;
  const drew = drawSpriteContain('balloon_note_question', x, y, rx * 2.7, ry * 2.6, 'center');
  ctx.restore();

  if (!drew) {
    ctx.fillStyle = placed ? 'rgba(155, 120, 214, 0.3)' : '#9b6cd6';
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#7a4fc0';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = '#b69be0';
    ctx.beginPath();
    ctx.moveTo(x, y + ry);
    ctx.quadraticCurveTo(x - 20, y + ry + 42, x + 8, y + ry + 84);
    ctx.stroke();
  }

  // Dynamic solfège label on a soft plate so the target stays readable over any art.
  const label = target?.solfege ?? '';
  if (label) {
    const fs = rx * 0.6;
    ctx.font = `900 ${fs}px ui-rounded, system-ui`;
    const plateW = ctx.measureText(label).width + fs;
    const plateH = fs * 1.5;
    ctx.save();
    ctx.globalAlpha = placed ? 0.5 : 1;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    roundedRect(x - plateW / 2, y - plateH / 2, plateW, plateH, plateH / 2);
    ctx.fill();
    ctx.fillStyle = '#6f43c0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 1);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }
}

function drawProjectile(width, height) {
  if (game.phase !== 'burst') return;
  const fromX = width * 0.15;
  const fromY = height * 0.78;
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
