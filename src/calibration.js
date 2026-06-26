import {
  buildSingingTemplate,
  centsBetween,
  frequencyToMidi,
  midiToFrequency
} from './audioAnalysis.js';
import { SOLFEGE, submitCalibration } from './notationGame.js';

// Each syllable is recorded this many times; the takes are kept and matched with
// min-DTW at game time, which is far more robust to a child's voice variation.
export const SING_TAKES = 2;

// Capture-quality gates. Tuning these is the main lever on later in-game
// recognition accuracy, so they live in one place and are exercised by tests.
// The audio engine emits an MFCC frame at most every ~0.12s, so minSamples must
// stay small enough that ~1s of a child's singing can satisfy it.
export const SING_CAPTURE = {
  minDuration: 0.7, // seconds of singing before a syllable can finalize
  minSamples: 5, // MFCC frames required (≈0.6s of voiced audio)
  maxDuration: 2.6, // auto-finalize after this with ≥3 samples so it never stalls
  minTimeoutSamples: 3,
  rmsGate: 0.012 // ignore frames quieter than this
};

export const PIANO_CAPTURE = {
  minDuration: 1.0, // seconds holding central C
  minSamples: 8, // stable pitch frames required
  maxDuration: 3.2, // auto-finalize after this with ≥4 samples
  minTimeoutSamples: 4,
  confidenceGate: 0.45, // ignore unstable pitch frames
  rmsGate: 0.012
};

export function createSingSession() {
  return {
    mode: 'sing',
    stepIndex: 0,
    takeIndex: 0,
    stepElapsed: 0,
    samples: [],
    takes: [], // takes captured for the CURRENT syllable
    templates: [],
    lastMfccFrameId: -1,
    done: false
  };
}

export function createPianoSession() {
  return {
    mode: 'play',
    elapsed: 0,
    samples: [],
    result: null,
    done: false
  };
}

export function activeSolfege(session) {
  return SOLFEGE[session.stepIndex] ?? null;
}

// Advance a singing session by one audio frame. Returns `takeCaptured` when one
// take finalizes, and `syllableDone` (the aggregated multi-take template) when
// all takes for the current syllable are collected.
export function feedSingFrame(session, live, dt) {
  if (session.done) return { session, takeCaptured: null, syllableDone: null, done: true };
  session.stepElapsed += dt;

  const isFreshFrame = live.mfcc
    && live.mfccFrameId !== session.lastMfccFrameId
    && live.rms >= SING_CAPTURE.rmsGate;
  if (isFreshFrame) {
    session.lastMfccFrameId = live.mfccFrameId;
    session.samples.push({
      frequency: live.frequency,
      rms: live.rms,
      confidence: live.confidence,
      mfcc: live.mfcc
    });
  }

  const ready = session.stepElapsed >= SING_CAPTURE.minDuration
    && session.samples.length >= SING_CAPTURE.minSamples;
  const timedOut = session.stepElapsed >= SING_CAPTURE.maxDuration
    && session.samples.length >= SING_CAPTURE.minTimeoutSamples;
  if (ready || timedOut) {
    const { takeCaptured, syllableDone } = finalizeTake(session);
    return { session, takeCaptured, syllableDone, done: session.done };
  }
  return { session, takeCaptured: null, syllableDone: null, done: session.done };
}

// Finalize the CURRENT take from whatever was captured (manual "next" button).
export function forceCaptureSing(session) {
  if (session.done || session.samples.length === 0) {
    return { takeCaptured: null, syllableDone: null, done: session.done };
  }
  const { takeCaptured, syllableDone } = finalizeTake(session);
  return { takeCaptured, syllableDone, done: session.done };
}

function finalizeTake(session) {
  const solfege = SOLFEGE[session.stepIndex];
  const take = buildSingingTemplate(solfege, session.samples);
  session.takes.push({ mfccSequence: take.mfccSequence ?? [], frequency: take.frequency ?? null });
  session.samples = [];
  session.stepElapsed = 0;
  session.takeIndex += 1;
  const takeCaptured = { solfege, take: session.takeIndex, midi: take.midi ?? null };

  let syllableDone = null;
  if (session.takeIndex >= SING_TAKES) {
    const sequences = session.takes.map((t) => t.mfccSequence).filter((s) => Array.isArray(s) && s.length > 0);
    const freqs = session.takes.map((t) => t.frequency).filter(Boolean);
    const avgFreq = freqs.length ? freqs.reduce((a, b) => a + b, 0) / freqs.length : null;
    const template = {
      solfege,
      completed: sequences.length > 0,
      takes: sequences,
      mfccSequence: sequences[0] ?? [], // back-compat for single-take matchers
      frequency: avgFreq,
      midi: avgFreq ? frequencyToMidi(avgFreq) : (take.midi ?? null),
      samples: session.takes.length
    };
    session.templates.push(template);
    syllableDone = { solfege, template, stepIndex: session.stepIndex };
    session.takes = [];
    session.takeIndex = 0;
    session.stepIndex += 1;
    if (session.stepIndex >= SOLFEGE.length) session.done = true;
  }
  return { takeCaptured, syllableDone };
}

// 0..1 progress for the current take, for a live capture bar in the UI.
export function singCaptureProgress(session) {
  if (!session || session.done) return 0;
  const byTime = session.stepElapsed / SING_CAPTURE.minDuration;
  const bySamples = session.samples.length / SING_CAPTURE.minSamples;
  return Math.max(0, Math.min(1, Math.min(byTime, bySamples)));
}

export function singTakeInfo(session) {
  return { take: (session?.takeIndex ?? 0) + 1, total: SING_TAKES };
}

// Advance a piano (central-C) session by one audio frame. Returns a `result`
// with the tuning offset on the frame capture completes.
export function feedPianoFrame(session, live, dt) {
  if (session.done) return { session, result: session.result, done: true };
  session.elapsed += dt;

  const stable = live.frequency
    && live.confidence >= PIANO_CAPTURE.confidenceGate
    && live.rms >= PIANO_CAPTURE.rmsGate;
  if (stable) session.samples.push(live.frequency);

  const ready = session.elapsed >= PIANO_CAPTURE.minDuration
    && session.samples.length >= PIANO_CAPTURE.minSamples;
  const timedOut = session.elapsed >= PIANO_CAPTURE.maxDuration
    && session.samples.length >= PIANO_CAPTURE.minTimeoutSamples;
  let result = null;
  if (ready || timedOut) {
    const averageFrequency = session.samples.reduce((sum, value) => sum + value, 0) / session.samples.length;
    result = {
      centralCOffsetCents: Math.round(centsBetween(midiToFrequency(60), averageFrequency)),
      referenceFrequency: averageFrequency,
      referenceMidi: 60
    };
    session.result = result;
    session.done = true;
  }
  return { session, result, done: session.done };
}

export function pianoCaptureProgress(session) {
  if (!session || session.done) return 0;
  const byTime = session.elapsed / PIANO_CAPTURE.minDuration;
  const bySamples = session.samples.length / PIANO_CAPTURE.minSamples;
  return Math.max(0, Math.min(1, Math.min(byTime, bySamples)));
}

export function singProgress(session) {
  return {
    completed: session.stepIndex,
    total: SOLFEGE.length,
    activeSolfege: activeSolfege(session)
  };
}

// --- persistence: write the calibration record games read back later ---

export function persistSingCalibration(store, templates, profileName = '小朋友') {
  return submitCalibration(store, 'sing', {
    syllables: SOLFEGE,
    templates,
    profileName
  });
}

export function persistPianoCalibration(store, result) {
  return submitCalibration(store, 'play', result);
}
