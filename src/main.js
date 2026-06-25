import {
  MODES,
  SOLFEGE,
  createGame,
  getCurrentTarget,
  getPlaybackEvents,
  loadCalibrationState,
  modeInputOptions,
  resetCalibration,
  settleBurst,
  staffYForNote,
  submitCalibration,
  submitInput
} from './notationGame.js';
import { createBrowserCalibrationStore, openProfileDatabase } from './storage.js';

const canvas = document.querySelector('#game-canvas');
const ctx = canvas.getContext('2d');
const inputPad = document.querySelector('#input-pad');
const modeButtons = {
  sing: document.querySelector('#mode-sing'),
  play: document.querySelector('#mode-play')
};
const calibrationStatus = document.querySelector('#calibration-status');
const calibrationCopy = document.querySelector('#calibration-copy');
const calibrateButton = document.querySelector('#calibrate');
const resetCalibrationButton = document.querySelector('#reset-calibration');
const enableAudioButton = document.querySelector('#enable-audio');
const audioStatus = document.querySelector('#audio-status');
const scoreEl = document.querySelector('#score');
const streakEl = document.querySelector('#streak');
const progressEl = document.querySelector('#progress');
const feedbackEl = document.querySelector('#feedback');
const restartButton = document.querySelector('#restart');
const playbackButton = document.querySelector('#playback');

const calibrationStore = createBrowserCalibrationStore();
let mode = 'sing';
let game = createGame({ mode });
let audioContext = null;
let microphoneReady = false;
let elapsed = 0;
let burstTimer = 0;
let playbackTimer = 0;
let playbackEvents = [];
let nextPlaybackIndex = 0;

openProfileDatabase().catch(() => null);

function setMode(nextMode) {
  mode = nextMode;
  game = createGame({ mode });
  elapsed = 0;
  burstTimer = 0;
  playbackTimer = 0;
  playbackEvents = [];
  nextPlaybackIndex = 0;
  updateModeButtons();
  renderInputPad();
  updateHud();
}

function updateModeButtons() {
  for (const [id, button] of Object.entries(modeButtons)) {
    const active = id === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
}

function handleCalibration() {
  if (mode === 'sing') {
    submitCalibration(calibrationStore, 'sing', { syllables: SOLFEGE, profileName: '小朋友' });
  } else {
    submitCalibration(calibrationStore, 'play', { centralCOffsetCents: -6, referenceMidi: 60 });
    const target = getCurrentTarget(game);
    if (target?.midi === 60) {
      submitInput(game, { mode: 'play', midi: 60 });
      burstTimer = 0.7;
    }
  }
  updateHud();
}

function handleResetCalibration() {
  resetCalibration(calibrationStore, mode);
  updateHud();
}

async function enableAudio() {
  audioContext ??= new AudioContext();
  try {
    if (navigator.mediaDevices?.getUserMedia) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    }
    microphoneReady = true;
    audioStatus.textContent = '已授权';
  } catch {
    microphoneReady = false;
    audioStatus.textContent = '未授权，可先用模拟按钮';
  }
}

function handleInput(option) {
  const payload = mode === 'sing'
    ? { mode, solfege: option.value }
    : { mode, midi: option.value };
  const result = submitInput(game, payload);
  if (result.correct) {
    burstTimer = 0.7;
    playTone(result.target.midi, 0.16);
    if (game.phase === 'playback') {
      startPlayback();
    }
  } else {
    playTone(48, 0.04);
  }
  updateHud();
}

function startPlayback() {
  game.phase = 'playback';
  playbackEvents = getPlaybackEvents(game);
  playbackTimer = 0;
  nextPlaybackIndex = 0;
  game.feedback = '全曲回放中';
  updateHud();
}

function restart() {
  game = createGame({ mode });
  elapsed = 0;
  burstTimer = 0;
  playbackTimer = 0;
  nextPlaybackIndex = 0;
  playbackEvents = [];
  renderInputPad();
  updateHud();
}

function playTone(midi, gainValue = 0.1) {
  if (!audioContext) return;
  const frequency = 440 * (2 ** ((midi - 69) / 12));
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(gainValue, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.45);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.45);
}

function update(dt) {
  elapsed += dt;
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
      playTone(playbackEvents[nextPlaybackIndex].midi, 0.08);
      nextPlaybackIndex += 1;
    }
    if (nextPlaybackIndex >= playbackEvents.length) {
      game.feedback = '回放完成，可以再玩一次';
    }
  }
}

function draw() {
  resizeCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);
  drawRoom(width, height);
  drawStaff(width, height);
  drawPlacedNotes(width);
  drawBalloon(width, height);
  drawLauncher(width, height);
  drawMistakes(width);
}

function drawRoom(width, height) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#fff8df');
  gradient.addColorStop(0.48, '#e9f8ff');
  gradient.addColorStop(1, '#fff0f6');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255, 210, 92, 0.18)';
  ctx.beginPath();
  ctx.arc(width * 0.13, height * 0.18, 120, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(74, 141, 246, 0.12)';
  ctx.beginPath();
  ctx.arc(width * 0.82, height * 0.16, 150, 0, Math.PI * 2);
  ctx.fill();
}

function drawStaff(width) {
  const x = width * 0.11;
  const staffWidth = width * 0.74;
  const top = 178;
  ctx.strokeStyle = '#26324a';
  ctx.lineWidth = 2;
  for (let line = 0; line < 5; line += 1) {
    const y = top + line * 28;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + staffWidth, y);
    ctx.stroke();
  }
  ctx.font = '800 28px ui-rounded, system-ui';
  ctx.fillStyle = '#26324a';
  ctx.fillText('𝄞', x - 54, top + 86);
}

function drawPlacedNotes(width) {
  const startX = width * 0.2;
  const gap = 68;
  for (const [index, songNote] of game.placedNotes.entries()) {
    const x = startX + index * gap;
    const y = staffYForNote(songNote);
    drawNoteHead(x, y, '#4a8df6');
    ctx.fillStyle = '#26324a';
    ctx.font = '800 17px ui-rounded, system-ui';
    ctx.fillText(songNote.solfege, x - 16, y + 38);
  }
}

function drawBalloon(width, height) {
  if (!game.balloon) return;
  const target = getCurrentTarget(game) ?? game.placedNotes.at(-1);
  const bob = Math.sin(elapsed * 2.8) * 10;
  const x = width * 0.68;
  const y = height * 0.44 + bob;
  const placed = game.balloon.state === 'placed';
  ctx.fillStyle = placed ? 'rgba(255, 138, 160, 0.25)' : '#ff8aa0';
  ctx.beginPath();
  ctx.ellipse(x, y, 70, 84, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#c9546d';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '950 42px ui-rounded, system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(target?.solfege ?? '', x, y + 12);
  ctx.textAlign = 'start';
  ctx.strokeStyle = '#8d6670';
  ctx.beginPath();
  ctx.moveTo(x, y + 84);
  ctx.quadraticCurveTo(x - 20, y + 126, x + 8, y + 164);
  ctx.stroke();

  if (placed) {
    ctx.fillStyle = '#ffd25c';
    ctx.font = '900 26px ui-rounded, system-ui';
    ctx.fillText('啪！', x + 78, y - 40);
  }
}

function drawLauncher(width, height) {
  const x = width * 0.18;
  const y = height * 0.72;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#26324a';
  ctx.lineWidth = 3;
  roundedRect(x - 74, y - 34, 148, 68, 18);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#4a8df6';
  ctx.font = '900 24px ui-rounded, system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('发射音符', x, y + 8);
  ctx.textAlign = 'start';

  if (game.projectile?.state === 'arrived') {
    const note = game.placedNotes.at(-1);
    const targetX = width * 0.2 + (game.placedNotes.length - 1) * 68;
    drawNoteHead(targetX, staffYForNote(note), '#ffd25c');
  }
}

function drawMistakes(width) {
  if (game.mistakes.length === 0) return;
  ctx.fillStyle = '#9a4b5b';
  ctx.font = '800 18px ui-rounded, system-ui';
  ctx.fillText(`温柔提示：已经尝试 ${game.mistakes.length} 次`, width * 0.1, 48);
}

function drawNoteHead(x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.32);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, 18, 13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = '#26324a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x + 15, y - 8);
  ctx.lineTo(x + 15, y - 70);
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

function updateHud() {
  const calibration = loadCalibrationState(calibrationStore, mode);
  calibrationStatus.textContent = calibration.completed ? '已校准' : '未校准';
  calibrationCopy.textContent = mode === 'sing'
    ? '录入 7 个音名模板；MVP 用按钮模拟识别结果。'
    : '弹一次中央 C 建立音准基准；MVP 用按钮模拟琴键。';
  scoreEl.textContent = String(game.score);
  streakEl.textContent = String(game.streak);
  progressEl.textContent = `${game.placedNotes.length} / ${game.song.notes.length}`;
  feedbackEl.textContent = game.feedback;
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * ratio);
  canvas.height = Math.floor(rect.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function tick(now) {
  if (!tick.last) tick.last = now;
  const dt = Math.min(0.05, (now - tick.last) / 1000);
  tick.last = now;
  update(dt);
  draw();
  updateHud();
  requestAnimationFrame(tick);
}

window.render_game_to_text = () => JSON.stringify({
  coordinateSystem: 'canvas origin top-left, x right, y down',
  mode,
  phase: game.phase,
  target: getCurrentTarget(game),
  score: game.score,
  streak: game.streak,
  placedNotes: game.placedNotes.map((note) => ({ id: note.id, solfege: note.solfege, midi: note.midi })),
  mistakes: game.mistakes.length,
  calibration: loadCalibrationState(calibrationStore, mode).completed,
  microphoneReady
});

window.advanceTime = (ms) => {
  const steps = Math.max(1, Math.round(ms / 16.67));
  for (let index = 0; index < steps; index += 1) update(1 / 60);
  draw();
  updateHud();
};

modeButtons.sing.addEventListener('click', () => setMode('sing'));
modeButtons.play.addEventListener('click', () => setMode('play'));
calibrateButton.addEventListener('click', handleCalibration);
resetCalibrationButton.addEventListener('click', handleResetCalibration);
enableAudioButton.addEventListener('click', enableAudio);
restartButton.addEventListener('click', restart);
playbackButton.addEventListener('click', startPlayback);
window.addEventListener('resize', resizeCanvas);

updateModeButtons();
renderInputPad();
updateHud();
requestAnimationFrame(tick);

