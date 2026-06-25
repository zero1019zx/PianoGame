import {
  buildSingingTemplate,
  centsBetween,
  classifyEnvironment,
  detectPitchFromTimeDomain,
  extractMfcc,
  frequencyToMidi,
  matchDetectedPitch,
  matchSingingTemplate,
  midiToFrequency
} from './audioAnalysis.js';
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
const environmentStatus = document.querySelector('#environment-status');
const levelMeter = document.querySelector('#level-meter');
const detectedNote = document.querySelector('#detected-note');
const detectedCents = document.querySelector('#detected-cents');
const scoreEl = document.querySelector('#score');
const streakEl = document.querySelector('#streak');
const progressEl = document.querySelector('#progress');
const feedbackEl = document.querySelector('#feedback');
const restartButton = document.querySelector('#restart');
const playbackButton = document.querySelector('#playback');
const playArea = document.querySelector('.play-area');
const stageModeLabel = document.querySelector('#stage-mode-label');
const stagePrompt = document.querySelector('#stage-prompt');
const singCalibrationGrid = document.querySelector('#sing-calibration-grid');
const pianoCalibrationCard = document.querySelector('#piano-calibration-card');
const pitchNeedle = document.querySelector('#pitch-needle');
const pianoCalibrationResult = document.querySelector('#piano-calibration-result');

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
let mediaStream = null;
let analyser = null;
let timeDomainBuffer = null;
let liveAudio = {
  frequency: null,
  midi: null,
  rms: 0,
  confidence: 0,
  environment: { status: 'quiet', label: '等待麦克风', score: 0 },
  centsFromTarget: null,
  mfcc: null,
  mfccFrameId: 0
};
let calibrationSession = null;
let audioJudgeCooldown = 0;
let mfccTimer = 0;
let mfccFrameId = 0;
let liveMfccSequence = [];

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
  renderCalibrationStage();
  renderInputPad();
  updateHud();
}

function updateModeButtons() {
  for (const [id, button] of Object.entries(modeButtons)) {
    const active = id === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  playArea.classList.toggle('mode-sing', mode === 'sing');
  playArea.classList.toggle('mode-play', mode === 'play');
}

function handleCalibration() {
  if (!microphoneReady) {
    applyDemoCalibration();
    game.feedback = '还未打开麦克风，已先启用演示校准；点击“打开麦克风”可做真实校准';
    updateHud();
    return;
  }
  calibrationSession = mode === 'sing'
    ? { mode, stepIndex: 0, stepElapsed: 0, samples: [], templates: [] }
    : { mode, elapsed: 0, samples: [] };
  game.feedback = mode === 'sing' ? '请跟着高亮音名唱，保持声音稳定' : '请弹中央 C，按住 2 到 3 秒';
  renderCalibrationStage();
  updateHud();
}

function handleResetCalibration() {
  resetCalibration(calibrationStore, mode);
  updateHud();
}

async function enableAudio() {
  audioContext ??= new AudioContext();
  try {
    await audioContext.resume();
    if (navigator.mediaDevices?.getUserMedia) {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 4096;
      audioContext.createMediaStreamSource(mediaStream).connect(analyser);
      timeDomainBuffer = new Float32Array(analyser.fftSize);
    }
    microphoneReady = true;
    audioStatus.textContent = '已授权，正在监听';
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

function applyDemoCalibration() {
  if (mode === 'sing') {
    const templates = SOLFEGE.map((solfege, index) => ({
      solfege,
      completed: true,
      frequency: midiToFrequency(60 + [0, 2, 4, 5, 7, 9, 11][index]),
      midi: 60 + [0, 2, 4, 5, 7, 9, 11][index],
      confidence: 1,
      samples: 1
    }));
    submitCalibration(calibrationStore, 'sing', { syllables: SOLFEGE, templates, profileName: '小朋友' });
  } else {
    submitCalibration(calibrationStore, 'play', { centralCOffsetCents: 0, referenceMidi: 60 });
  }
  renderCalibrationStage();
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
  audioJudgeCooldown = Math.max(0, audioJudgeCooldown - dt);
  updateLiveAudio(dt);
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

function updateLiveAudio(dt) {
  if (!analyser || !timeDomainBuffer) return;
  analyser.getFloatTimeDomainData(timeDomainBuffer);
  const detected = detectPitchFromTimeDomain(timeDomainBuffer, audioContext.sampleRate);
  mfccTimer -= dt;
  let mfcc = liveAudio.mfcc;
  if (mfccTimer <= 0) {
    mfccTimer = 0.12;
    mfcc = extractMfcc(timeDomainBuffer, audioContext.sampleRate);
    mfccFrameId += 1;
    liveMfccSequence.push(mfcc);
    if (liveMfccSequence.length > 18) {
      liveMfccSequence = liveMfccSequence.slice(-18);
    }
  }
  liveAudio = {
    ...liveAudio,
    ...detected,
    midi: frequencyToMidi(detected.frequency),
    environment: classifyEnvironment(detected),
    mfcc,
    mfccFrameId
  };
  handleActiveCalibration(dt);
  maybeJudgeLiveAudio();
}

function handleActiveCalibration(dt) {
  if (!calibrationSession) return;
  if (calibrationSession.mode === 'sing') {
    const solfege = SOLFEGE[calibrationSession.stepIndex];
    calibrationSession.stepElapsed += dt;
    if (
      liveAudio.mfcc
      && liveAudio.mfccFrameId !== calibrationSession.lastMfccFrameId
      && liveAudio.rms >= 0.015
    ) {
      calibrationSession.lastMfccFrameId = liveAudio.mfccFrameId;
      calibrationSession.samples.push({
        frequency: liveAudio.frequency,
        rms: liveAudio.rms,
        confidence: liveAudio.confidence,
        mfcc: liveAudio.mfcc
      });
    }
    if (calibrationSession.stepElapsed >= 1.05 && calibrationSession.samples.length >= 12) {
      calibrationSession.templates.push(buildSingingTemplate(solfege, calibrationSession.samples));
      calibrationSession.stepIndex += 1;
      calibrationSession.stepElapsed = 0;
      calibrationSession.samples = [];
      if (calibrationSession.stepIndex >= SOLFEGE.length) {
        submitCalibration(calibrationStore, 'sing', {
          syllables: SOLFEGE,
          templates: calibrationSession.templates,
          profileName: '小朋友'
        });
        calibrationSession = null;
        game.feedback = '唱谱校准完成，可以对着气球唱音名';
      }
    }
    renderCalibrationStage();
  } else {
    calibrationSession.elapsed += dt;
    if (liveAudio.frequency && liveAudio.confidence >= 0.52 && liveAudio.rms >= 0.012) {
      calibrationSession.samples.push(liveAudio.frequency);
    }
    if (calibrationSession.elapsed >= 1.6 && calibrationSession.samples.length >= 16) {
      const averageFrequency = calibrationSession.samples.reduce((sum, value) => sum + value, 0) / calibrationSession.samples.length;
      const centralCOffsetCents = Math.round(centsBetween(midiToFrequency(60), averageFrequency));
      submitCalibration(calibrationStore, 'play', {
        centralCOffsetCents,
        referenceMidi: 60,
        referenceFrequency: averageFrequency
      });
      calibrationSession = null;
      game.feedback = '中央 C 校准完成，弹对当前气球就会发射音符';
      const target = getCurrentTarget(game);
      if (target?.midi === 60) {
        submitInput(game, { mode: 'play', midi: 60 });
        burstTimer = 0.7;
      }
    }
    renderCalibrationStage();
  }
}

function maybeJudgeLiveAudio() {
  if (!microphoneReady || calibrationSession || audioJudgeCooldown > 0 || game.phase !== 'aiming') return;
  const target = getCurrentTarget(game);
  if (!target || !liveAudio.frequency || liveAudio.confidence < 0.56 || liveAudio.rms < 0.014) return;
  const calibration = loadCalibrationState(calibrationStore, mode);
  if (!calibration.completed) return;

  if (mode === 'sing') {
    const templates = calibration.templates ?? [];
    const match = matchSingingTemplate({
      detectedFrequency: liveAudio.frequency,
      detectedMfccSequence: liveMfccSequence.slice(-10),
      templates,
      toleranceCents: 140,
      tolerance: 24
    });
    if (match.correct && match.solfege === target.solfege) {
      const result = submitInput(game, { mode: 'sing', solfege: target.solfege });
      handleAudioHit(result);
    } else if (match.correct && match.solfege && match.solfege !== target.solfege) {
      submitInput(game, { mode: 'sing', solfege: match.solfege });
      audioJudgeCooldown = 1.1;
    }
    liveAudio.centsFromTarget = match.cents;
  } else {
    const match = matchDetectedPitch({
      targetMidi: target.midi,
      detectedFrequency: liveAudio.frequency,
      centralCOffsetCents: calibration.centralCOffsetCents,
      toleranceCents: 55
    });
    liveAudio.centsFromTarget = match.cents;
    if (match.correct) {
      const result = submitInput(game, { mode: 'play', midi: target.midi });
      handleAudioHit(result);
    } else if (Math.abs(match.cents) > 90) {
      submitInput(game, { mode: 'play', midi: match.midi });
      audioJudgeCooldown = 1.1;
    }
  }
}

function handleAudioHit(result) {
  if (!result.correct) return;
  burstTimer = 0.7;
  audioJudgeCooldown = 0.95;
  playTone(result.target.midi, 0.16);
  if (game.phase === 'playback') startPlayback();
  renderInputPad();
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

function renderCalibrationStage() {
  const calibration = loadCalibrationState(calibrationStore, mode);
  stageModeLabel.textContent = mode === 'sing' ? '唱谱校准' : '钢琴校准';
  playArea.classList.toggle('mode-sing', mode === 'sing');
  playArea.classList.toggle('mode-play', mode === 'play');

  if (mode === 'sing') {
    const activeIndex = calibrationSession?.mode === 'sing' ? calibrationSession.stepIndex : -1;
    const templates = calibration.templates ?? [];
    stagePrompt.textContent = calibrationSession?.mode === 'sing'
      ? `请唱 ${SOLFEGE[activeIndex]}，保持 1 秒`
      : calibration.completed
        ? '唱谱模板已完成，对着气球唱音名即可'
        : '请打开麦克风后，依次唱 Do Re Mi Fa Sol La Si，系统会提取 MFCC 模板';
    singCalibrationGrid.innerHTML = '';
    for (const [index, solfege] of SOLFEGE.entries()) {
      const done = templates.some((template) => template.solfege === solfege && template.completed)
        || (calibrationSession?.mode === 'sing' && index < calibrationSession.stepIndex);
      const card = document.createElement('div');
      card.className = 'syllable-card';
      card.classList.toggle('active', index === activeIndex);
      card.classList.toggle('done', done);
      card.innerHTML = `
        <strong>${solfege}</strong>
        <div class="wave-mini" aria-hidden="true"></div>
        <span>${done ? '已识别' : index === activeIndex ? '录音中' : '待录入'}</span>
      `;
      singCalibrationGrid.append(card);
    }
  } else {
    const offset = calibration.centralCOffsetCents ?? 0;
    const clamped = Math.max(-50, Math.min(50, offset));
    pitchNeedle.style.transform = `translateX(-50%) rotate(${clamped * 0.75}deg)`;
    stagePrompt.textContent = calibrationSession?.mode === 'play'
      ? '请弹钢琴上的中央 C，按住 2 到 3 秒'
      : calibration.completed
        ? '中央 C 已校准，弹当前气球对应琴键'
        : '请打开麦克风后弹中央 C 完成校准';
    pianoCalibrationResult.textContent = calibration.completed
      ? `音准良好，偏移 ${offset} cents`
      : '等待中央 C';
  }
}

function updateHud() {
  const calibration = loadCalibrationState(calibrationStore, mode);
  calibrationStatus.textContent = calibration.completed ? '已校准' : '未校准';
  calibrationCopy.textContent = mode === 'sing'
    ? '打开麦克风后依次唱 7 个音名，系统会保存本地 MFCC 模板并用 DTW 匹配。'
    : '打开麦克风后弹中央 C，系统会匹配这台钢琴的音准。';
  environmentStatus.textContent = liveAudio.environment.label;
  levelMeter.style.width = `${Math.min(100, Math.round(liveAudio.rms * 620))}%`;
  detectedNote.textContent = liveAudio.midi ? midiName(liveAudio.midi) : '--';
  detectedCents.textContent = Number.isFinite(liveAudio.centsFromTarget)
    ? `${liveAudio.centsFromTarget > 0 ? '+' : ''}${Math.round(liveAudio.centsFromTarget)} cents`
    : '--';
  scoreEl.textContent = String(game.score);
  streakEl.textContent = String(game.streak);
  progressEl.textContent = `${game.placedNotes.length} / ${game.song.notes.length}`;
  feedbackEl.textContent = game.feedback;
  renderCalibrationStage();
}

function midiName(midi) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
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
  microphoneReady,
  liveAudio: {
    midi: liveAudio.midi,
    frequency: liveAudio.frequency,
    rms: liveAudio.rms,
    confidence: liveAudio.confidence,
    environment: liveAudio.environment.status,
    mfccFrames: liveMfccSequence.length
  },
  calibrationSession: calibrationSession
    ? { mode: calibrationSession.mode, stepIndex: calibrationSession.stepIndex ?? null }
    : null
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
