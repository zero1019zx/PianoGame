import {
  classifyEnvironment,
  detectPitchFromTimeDomain,
  extractMfcc,
  frequencyToMidi,
  rootMeanSquare
} from './audioAnalysis.js';

// One shared microphone + Web Audio pipeline for calibration and both games.
// Heavy work is throttled so the iPad render loop can hold 60fps:
//   - RMS (cheap, O(n)) runs every frame for a smooth level meter.
//   - Autocorrelation pitch detection is decimated to every other frame.
//   - MFCC extraction runs at most once every MFCC_INTERVAL seconds.
const MFCC_INTERVAL = 0.12;
const PITCH_DECIMATION = 2;
const MFCC_SEQUENCE_LIMIT = 18;
const SILENCE_RMS = 0.01;

export function createAudioEngine() {
  let audioContext = null;
  let mediaStream = null;
  let analyser = null;
  let timeBuffer = null;
  let ready = false;

  let mfccTimer = 0;
  let mfccFrameId = 0;
  let pitchFrame = 0;
  let mfccSequence = [];
  let live = freshLive();

  async function enable() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return { ok: false, reason: 'unsupported' };
    audioContext ??= new AudioCtx();
    try {
      await audioContext.resume();
    } catch {
      // resume can reject if not triggered by a gesture; getUserMedia below still gates access.
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      ready = false;
      return { ok: false, reason: 'unsupported' };
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
    } catch (error) {
      ready = false;
      return { ok: false, reason: error?.name === 'NotAllowedError' ? 'denied' : 'error' };
    }
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    audioContext.createMediaStreamSource(mediaStream).connect(analyser);
    timeBuffer = new Float32Array(analyser.fftSize);
    ready = true;
    return { ok: true };
  }

  function disable() {
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    analyser = null;
    timeBuffer = null;
    ready = false;
    mfccSequence = [];
    live = freshLive();
  }

  function resetSequence() {
    mfccSequence = [];
  }

  function pull(dt) {
    if (!ready || !analyser || !timeBuffer) return live;
    analyser.getFloatTimeDomainData(timeBuffer);
    const rms = rootMeanSquare(timeBuffer);

    pitchFrame = (pitchFrame + 1) % PITCH_DECIMATION;
    let frequency = live.frequency;
    let confidence = live.confidence;
    if (rms < SILENCE_RMS) {
      frequency = null;
      confidence = 0;
    } else if (pitchFrame === 0) {
      const detected = detectPitchFromTimeDomain(timeBuffer, audioContext.sampleRate);
      frequency = detected.frequency;
      confidence = detected.confidence;
    }

    mfccTimer -= dt;
    let mfcc = live.mfcc;
    if (mfccTimer <= 0 && rms >= 0.012) {
      mfccTimer = MFCC_INTERVAL;
      mfcc = extractMfcc(timeBuffer, audioContext.sampleRate);
      mfccFrameId += 1;
      mfccSequence.push(mfcc);
      if (mfccSequence.length > MFCC_SEQUENCE_LIMIT) {
        mfccSequence = mfccSequence.slice(-MFCC_SEQUENCE_LIMIT);
      }
    }

    live = {
      frequency,
      midi: frequencyToMidi(frequency),
      rms,
      confidence,
      environment: classifyEnvironment({ rms, confidence }),
      mfcc,
      mfccFrameId,
      mfccSequence
    };
    return live;
  }

  function playTone(midi, gainValue = 0.1, duration = 0.45) {
    if (!audioContext) return;
    const frequency = 440 * (2 ** ((midi - 69) / 12));
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(gainValue, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + duration);
  }

  return {
    enable,
    disable,
    resetSequence,
    pull,
    playTone,
    isReady: () => ready,
    getLive: () => live
  };
}

function freshLive() {
  return {
    frequency: null,
    midi: null,
    rms: 0,
    confidence: 0,
    environment: { status: 'idle', label: '等待麦克风', score: 0 },
    mfcc: null,
    mfccFrameId: 0,
    mfccSequence: []
  };
}
