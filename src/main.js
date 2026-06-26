import {
  centsBetween,
  createPitchHold,
  matchDetectedPitch,
  midiToFrequency,
  pitchClassCentsToMidi,
  updatePitchHold
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
  SING_CAPTURE,
  SING_TAKES,
  createPianoSession,
  createSingSession,
  feedPianoFrame,
  feedSingFrame,
  forceCaptureSing,
  persistPianoCalibration,
  persistSingCalibration,
  singCaptureProgress,
  singTakeInfo
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
const calSingControls = document.querySelector('#cal-sing-controls');
const calSingHint = document.querySelector('#cal-sing-hint');
const calNextBtn = document.querySelector('#cal-next');
const calDebugToggle = document.querySelector('#cal-debug-toggle');
const calDebug = document.querySelector('#cal-debug');
const calDebugClose = document.querySelector('#cal-debug-close');
const dbgStats = document.querySelector('#dbg-stats');
const dbgMic = document.querySelector('#dbg-mic');
const dbgRecord = document.querySelector('#dbg-record');
const dbgDownloadLog = document.querySelector('#dbg-download-log');
const dbgRecordState = document.querySelector('#dbg-record-state');
const recogModeEl = document.querySelector('#recog-mode');

function renderRecogMode() {
  recogModeEl.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === recognitionMode);
  });
}
recogModeEl.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-mode]');
  if (!btn) return;
  saveRecognitionMode(btn.dataset.mode);
  renderRecogMode();
});

let cal = { phase: 'idle', sing: null, piano: null, lastNeedle: 0 };
let debugOpen = false;
let debugRecording = false;
let debugLog = [];
let debugElapsed = 0;
let debugRecTimer = 0;

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
      <span class="state">${done ? '已识别' : active ? `第${singTakeInfo(cal.sing).take}/${singTakeInfo(cal.sing).total}遍` : '待录入'}</span>
      ${active ? '<div class="syl-progress"><i></i></div>' : ''}`;
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
  calSingControls.hidden = false;
  calSingHint.textContent = '请大声唱出高亮的音名～';
  renderSyllables();
  renderPianoResult();
}

function finishSingPhase() {
  persistSingCalibration(store, cal.sing.templates);
  snapshotProfile();
  cal.phase = 'piano';
  cal.piano = createPianoSession();
  calSingControls.hidden = true;
  engine.resetSequence();
  renderSyllables();
  renderPianoResult();
}

function manualNextSyllable() {
  if (cal.phase !== 'sing') return;
  const { takeCaptured, done } = forceCaptureSing(cal.sing);
  if (!takeCaptured) {
    calSingHint.textContent = '先唱一下这个音再点哦～';
    return;
  }
  engine.playTone(takeCaptured.midi ?? SOLFEGE_MIDI[SOLFEGE.indexOf(takeCaptured.solfege)], 0.16);
  renderSyllables();
  if (done) finishSingPhase();
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
    const { takeCaptured, done } = feedSingFrame(cal.sing, live, dt);
    if (takeCaptured) {
      engine.playTone(takeCaptured.midi ?? SOLFEGE_MIDI[SOLFEGE.indexOf(takeCaptured.solfege)], 0.16);
      renderSyllables();
    }
    if (done) {
      finishSingPhase();
    } else {
      const fill = calSyllables.querySelector('.syllable-card.active .syl-progress i');
      if (fill) fill.style.width = `${Math.round(singCaptureProgress(cal.sing) * 100)}%`;
      const solfege = SOLFEGE[cal.sing.stepIndex] ?? '';
      const { take, total } = singTakeInfo(cal.sing);
      calSingHint.textContent = live.rms >= 0.012
        ? `听到啦，唱「${solfege}」(第 ${take}/${total} 遍)…`
        : `没听到声音，靠近麦克风大声唱「${solfege}」～`;
    }
  } else if (cal.phase === 'piano') {
    if (live.frequency) renderNeedle(centsBetween(midiToFrequency(60), live.frequency));
    const { result, done } = feedPianoFrame(cal.piano, live, dt);
    if (done && result) {
      engine.playTone(60, 0.18);
      finishPianoPhase(result);
    }
  }

  if (debugOpen) updateDebugStats(live);
  if (debugRecording) {
    debugElapsed += dt;
    debugRecTimer -= dt;
    debugLog.push({
      t: Number(debugElapsed.toFixed(2)),
      rms: Number(live.rms.toFixed(4)),
      f0: live.frequency ? Math.round(live.frequency) : null,
      conf: Number(live.confidence.toFixed(2)),
      mfcc: live.mfccFrameId,
      samples: cal.sing ? cal.sing.samples.length : 0,
      phase: cal.phase
    });
    if (debugRecTimer <= 0) {
      debugRecording = false;
      finishDebugRecording();
    }
  }
}

// ---- microphone diagnostics: live readout + record-and-download ----
function updateDebugStats(live) {
  const c = cal.sing;
  const sr = engine.getSampleRate();
  dbgStats.textContent =
    `mic ${engine.isReady() ? '✓' : '✗'} | ${sr ? `${sr}Hz` : '-'} | rms ${live.rms.toFixed(3)} (gate ${SING_CAPTURE.rmsGate}) | `
    + `f0 ${live.frequency ? `${Math.round(live.frequency)}Hz` : '-'} | conf ${live.confidence.toFixed(2)} | mfcc#${live.mfccFrameId} | `
    + `本遍采样 ${c ? c.samples.length : 0}/${SING_CAPTURE.minSamples} | 阶段 ${cal.phase}`
    + (c ? ` · ${SOLFEGE[c.stepIndex] ?? '-'} 第${(c.takeIndex ?? 0) + 1}/${SING_TAKES}遍` : '');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function debugEnableMic() {
  dbgRecordState.textContent = '正在请求麦克风…';
  const result = await engine.enable();
  dbgRecordState.textContent = result.ok
    ? '麦克风已就绪，出声看 rms 是否跳动'
    : `麦克风打开失败：${result.reason}（注意：file:// 直接打开会禁麦，请用 npm run serve）`;
}

async function startDebugRecording() {
  if (!engine.isReady()) {
    const result = await engine.enable();
    if (!result.ok) {
      dbgRecordState.textContent = `麦克风未就绪：${result.reason}`;
      return;
    }
  }
  debugLog = [];
  debugElapsed = 0;
  debugRecTimer = 5;
  debugRecording = true;
  const ok = engine.startCapture();
  dbgRecordState.textContent = ok ? '● 录音中…请大声唱 Do～(5 秒)' : '此浏览器不支持录音，仅记录数值日志(5 秒)';
}

async function finishDebugRecording() {
  const blob = await engine.stopCapture();
  const rmsMax = debugLog.reduce((m, r) => Math.max(m, r.rms), 0);
  const framesWithSignal = debugLog.filter((r) => r.rms >= SING_CAPTURE.rmsGate).length;
  const payload = {
    meta: {
      createdAt: new Date().toISOString(),
      micReady: engine.isReady(),
      sampleRate: engine.getSampleRate(),
      frames: debugLog.length,
      rmsMax: Number(rmsMax.toFixed(4)),
      framesWithSignal,
      rmsGate: SING_CAPTURE.rmsGate,
      minSamples: SING_CAPTURE.minSamples
    },
    log: debugLog
  };
  try {
    window.localStorage.setItem('notation-debug-last', JSON.stringify(payload));
  } catch {
    // localStorage may be unavailable; download still works.
  }
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'calib-debug-log.json');
  if (blob) {
    const ext = (blob.type.split('/')[1] || 'webm').split(';')[0];
    downloadBlob(blob, `calib-debug-audio.${ext}`);
  }
  dbgRecordState.textContent = `完成：rms峰值 ${rmsMax.toFixed(3)}，有信号帧 ${framesWithSignal}/${debugLog.length}`
    + (blob ? '，已下载 音频+日志' : '(此浏览器没录到音频)，已下载日志');
}

function downloadLastLog() {
  let raw = null;
  try {
    raw = window.localStorage.getItem('notation-debug-last');
  } catch {
    raw = null;
  }
  if (!raw) {
    dbgRecordState.textContent = '还没有日志，先点「录 5 秒并下载」';
    return;
  }
  downloadBlob(new Blob([raw], { type: 'application/json' }), 'calib-debug-log.json');
}

calStartBtn.addEventListener('click', startCalibration);
calNextBtn.addEventListener('click', manualNextSyllable);
calDebugToggle.addEventListener('click', () => {
  debugOpen = !debugOpen;
  calDebug.hidden = !debugOpen;
});
calDebugClose.addEventListener('click', () => {
  debugOpen = false;
  calDebug.hidden = true;
});
dbgMic.addEventListener('click', debugEnableMic);
dbgRecord.addEventListener('click', startDebugRecording);
dbgDownloadLog.addEventListener('click', downloadLastLog);
calResetBtn.addEventListener('click', () => {
  resetCalibration(store, 'sing');
  resetCalibration(store, 'play');
  saveCalibrationProfile({ sing: null, play: null }).catch(() => null);
  cal = { phase: 'idle', sing: null, piano: null, lastNeedle: 0 };
  calStartBtn.querySelector('small').textContent = '一步步完成校准';
  calSingControls.hidden = true;
  renderSyllables();
  renderPianoResult();
});
calDoneBtn.addEventListener('click', () => go('home'));

const calibrationScreen = {
  enter() {
    cal = { phase: 'idle', sing: null, piano: null, lastNeedle: 0 };
    calEnvPill.textContent = engine.isReady() ? '麦克风已就绪' : '等待麦克风';
    calSingControls.hidden = true;
    renderRecogMode();
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
  sing: { name: '唱谱模式', sub: '唱准气球里这个音' },
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
let liveRecognized = null;
let hitAnim = null;

// Recognition strictness for 唱谱模式. Pitch is the real arbiter now: the child
// must SING the target note's pitch (octave-agnostic) and HOLD it for a few
// analysis frames. `cents` is the pitch tolerance — wide enough to forgive a
// child's wobble and timbre, but never so wide that talking/noise slips through.
// `minFrames` is how many consecutive on-target pitch frames are required, which
// is what rejects a stray sound. Larger = stricter.
const RECOG = {
  loose: { cents: 95, minFrames: 4 },
  standard: { cents: 60, minFrames: 5 },
  strict: { cents: 38, minFrames: 6 }
};
let recognitionMode = loadRecognitionMode();
// Per-balloon pitch-hold tracker (the "stable + matching" double check).
let pitchHold = createPitchHold();
let lastJudgedTargetId = null;
let lastPitchFrameId = -1;

function loadRecognitionMode() {
  try {
    return window.localStorage.getItem('notation-recognition-mode') || 'loose';
  } catch {
    return 'loose';
  }
}
function saveRecognitionMode(value) {
  recognitionMode = value;
  try {
    window.localStorage.setItem('notation-recognition-mode', value);
  } catch {
    // ignore
  }
}
function resetPitchHold() {
  pitchHold = createPitchHold();
  lastJudgedTargetId = getCurrentTarget(game)?.id ?? null;
}
// Nearest solfège to a detected pitch (octave-agnostic) — honest live feedback of
// what note the child is actually singing, not a timbre guess.
function nearestSolfege(frequency) {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  let best = 0;
  let bestDistance = Infinity;
  SOLFEGE_MIDI.forEach((midi, index) => {
    const distance = Math.abs(pitchClassCentsToMidi(frequency, midi) ?? Infinity);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return SOLFEGE[best];
}

const HUD_COPY = {
  sing: { title: '请唱出气球里的音符', sub: '唱对后，音符会飞上去填在乐谱上哦！' },
  play: { title: '看气球里的音符，在钢琴上弹出它！', sub: '弹对后，音符会飞上去填在乐谱上哦！' }
};

// Hit animation timeline: cannon shot → balloon pop → note flies to its staff slot.
const ANIM = { launch: 0.32, pop: 0.2, fly: 0.46 };
const ANIM_TOTAL = ANIM.launch + ANIM.pop + ANIM.fly;

function startHitAnim(target) {
  hitAnim = {
    t: 0,
    note: target,
    slot: Math.max(0, game.placedNotes.length - 1),
    from: { ...balloonPos }
  };
}

function startGame(nextMode) {
  mode = nextMode;
  game = createGame({ mode });
  elapsed = 0;
  burstTimer = 0;
  playbackTimer = 0;
  playbackEvents = [];
  nextPlaybackIndex = 0;
  liveCents = null;
  liveRecognized = null;
  wrongFlash = 0;
  bestStreak = 0;
  hitAnim = null;
  pitchHold = createPitchHold();
  lastJudgedTargetId = null;
  lastPitchFrameId = -1;
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
    startHitAnim(result.target);
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
  if (!engine.isReady() || game.phase !== 'aiming') return;
  const target = getCurrentTarget(game);
  if (!target) return;

  // New balloon → start a fresh hold so the previous note can't carry over.
  if (target.id !== lastJudgedTargetId) resetPitchHold();

  const calibration = loadCalibrationState(store, mode);
  if (!calibration.completed) return;
  if (audioJudgeCooldown > 0) return;

  // Only act on a freshly computed pitch frame so the hold counts real analyses,
  // not repeated render frames.
  if (live.pitchFrameId === lastPitchFrameId) return;
  lastPitchFrameId = live.pitchFrameId;

  if (mode === 'sing') {
    const cfg = RECOG[recognitionMode] ?? RECOG.loose;
    // DOUBLE CHECK: (1) a clear, voiced pitch must exist (detector returns null
    // for noise/speech), and (2) that pitch must match the target note, held for
    // `minFrames`. Talking or background noise satisfies neither, so it can no
    // longer trigger a hit — which was the core bug.
    const evaluation = updatePitchHold(pitchHold, { frequency: live.frequency }, {
      targetMidi: target.midi,
      toleranceCents: cfg.cents,
      minFrames: cfg.minFrames
    });
    pitchHold = evaluation.hold;
    liveCents = evaluation.voiced ? evaluation.cents : null;
    if (live.frequency) liveRecognized = nearestSolfege(live.frequency);
    if (evaluation.hit) {
      registerAudioHit(submitInput(game, { mode: 'sing', solfege: target.solfege }));
    }
  } else {
    // 弹奏模式: a confident, in-tune pitch held briefly. No auto-penalty — a wrong
    // or misheard note simply doesn't advance, it never marks a mistake.
    if (!live.frequency || live.confidence < 0.6) {
      liveCents = null;
      pitchHold = updatePitchHold(pitchHold, { frequency: null }, {
        targetMidi: target.midi, toleranceCents: 55, minFrames: 2
      }).hold;
      return;
    }
    const match = matchDetectedPitch({
      targetMidi: target.midi,
      detectedFrequency: live.frequency,
      centralCOffsetCents: calibration.centralCOffsetCents,
      toleranceCents: 55
    });
    liveCents = match.cents;
    const evaluation = updatePitchHold(pitchHold, { frequency: live.frequency }, {
      targetMidi: target.midi, toleranceCents: 60, minFrames: 2
    });
    pitchHold = evaluation.hold;
    if (evaluation.hit && match.correct) {
      registerAudioHit(submitInput(game, { mode: 'play', midi: target.midi }));
    }
  }
}

function registerAudioHit(result) {
  if (!result.correct) return;
  startHitAnim(result.target);
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

  if (hitAnim) {
    hitAnim.t += dt;
    if (hitAnim.t >= ANIM_TOTAL) {
      hitAnim = null;
      if (game.phase === 'burst') {
        settleBurst(game);
        renderInputs();
      }
    }
  } else if (game.phase === 'burst') {
    settleBurst(game);
    renderInputs();
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
  listenPanel.classList.toggle('live', live.rms > 0.015);
  detectedNote.textContent = mode === 'sing'
    ? (liveRecognized ?? '--')
    : (live.midi ? midiName(live.midi) : '--');
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
  drawLauncher(width, height);
  drawHitAnim(width, height);
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
    // The most recently placed note is the one currently flying in the hit animation.
    if (hitAnim && index === game.placedNotes.length - 1) return;
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
  // During a hit the balloon only shows while the projectile is incoming, then pops.
  if (hitAnim) {
    if (hitAnim.t < ANIM.launch) {
      drawBalloonAt(hitAnim.from.x, hitAnim.from.y, hitAnim.from.rx, hitAnim.from.ry, hitAnim.note);
    }
    return;
  }
  if (!game.balloon) return;
  const target = getCurrentTarget(game);
  if (!target) return;
  const bob = Math.sin(elapsed * 2.8) * 10;
  const x = width * 0.6;
  const y = height * 0.52 + bob;
  const rx = Math.min(94, width * 0.088);
  const ry = rx * 1.16;
  balloonPos = { x, y, rx, ry };
  drawBalloonAt(x, y, rx, ry, target);
}

function drawBalloonAt(x, y, rx, ry, note) {
  const drew = drawSpriteContain('balloon_note_question', x, y, rx * 2.7, ry * 2.6, 'center');
  if (!drew) {
    ctx.fillStyle = '#9b6cd6';
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
  if (note) drawBalloonNotation(x, y, rx, ry, note);
}

function drawBalloonNotation(x, y, rx, ry, target) {
  // Compact notation window on the upper half of the balloon (smaller than the balloon).
  const winW = rx * 1.12;
  const winH = ry * 0.82;
  const cy = y - ry * 0.05;
  const mg = winH * 0.18;
  const sw = winW * 0.38;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  roundedRect(x - winW / 2, cy - winH / 2, winW, winH, winH * 0.18);
  ctx.fill();
  ctx.strokeStyle = 'rgba(43, 58, 79, 0.8)';
  ctx.lineWidth = 1.4;
  for (let k = 0; k < 5; k += 1) {
    const ly = cy + (k - 2) * mg;
    ctx.beginPath();
    ctx.moveTo(x - sw, ly);
    ctx.lineTo(x + sw, ly);
    ctx.stroke();
  }
  const ny = cy + 2 * mg - target.staffStep * (mg * 0.5);
  const color = SOLF_COLORS[SOLFEGE.indexOf(target.solfege)] ?? '#46566f';
  ctx.save();
  ctx.translate(x, ny);
  ctx.rotate(-0.3);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, mg * 0.6, mg * 0.46, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(x + mg * 0.52, ny - 1);
  ctx.lineTo(x + mg * 0.52, ny - mg * 2.1);
  ctx.stroke();
  ctx.restore();
}

function drawHitAnim(width, height) {
  if (!hitAnim) return;
  const t = hitAnim.t;
  const b = hitAnim.from;
  const cannonX = width * 0.15;
  const cannonY = height * 0.8;
  const color = SOLF_COLORS[SOLFEGE.indexOf(hitAnim.note.solfege)] ?? '#3f8de0';

  if (t < ANIM.launch) {
    const p = t / ANIM.launch;
    const x = cannonX + (b.x - cannonX) * p;
    const y = cannonY + (b.y - cannonY) * p - Math.sin(p * Math.PI) * 60;
    const size = Math.min(64, width * 0.05);
    if (!drawSpriteContain('note_projectile', x, y, size, size, 'center')) {
      drawNoteHead(x, y, staffGap(height), '#ffd25c');
    }
  } else if (t < ANIM.launch + ANIM.pop) {
    drawPop(b.x, b.y, b.rx, (t - ANIM.launch) / ANIM.pop);
  } else {
    const p = Math.min(1, (t - ANIM.launch - ANIM.pop) / ANIM.fly);
    const e = p * p * (3 - 2 * p); // smoothstep
    const gap = (width * 0.6) / Math.max(1, game.song.notes.length - 1);
    const tx = width * 0.2 + hitAnim.slot * gap;
    const ty = noteY(height, hitAnim.note);
    const x = b.x + (tx - b.x) * e;
    const y = b.y + (ty - b.y) * e;
    drawNoteHead(x, y, staffGap(height), color);
  }
}

function drawPop(x, y, rx, p) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, 1 - p);
  ctx.strokeStyle = '#9b6cd6';
  ctx.lineWidth = 3;
  const r = rx * (1 + p * 0.9);
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * rx * 0.5, y + Math.sin(a) * rx * 0.5);
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    ctx.stroke();
  }
  ctx.fillStyle = '#ffd25c';
  ctx.font = `900 ${rx * 0.55}px ui-rounded, system-ui`;
  ctx.textAlign = 'center';
  ctx.fillText('啪！', x, y - r * 0.5);
  ctx.textAlign = 'start';
  ctx.restore();
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
