import {
  buildSingingTemplate,
  centsBetween,
  midiToFrequency
} from './audioAnalysis.js';
import { SOLFEGE, submitCalibration } from './notationGame.js';

// Capture-quality gates. Tuning these is the main lever on later in-game
// recognition accuracy, so they live in one place and are exercised by tests.
export const SING_CAPTURE = {
  minDuration: 1.0, // seconds of singing required per syllable
  minSamples: 12, // MFCC frames required per syllable
  rmsGate: 0.015 // ignore frames quieter than this
};

export const PIANO_CAPTURE = {
  minDuration: 1.4, // seconds holding central C
  minSamples: 14, // stable pitch frames required
  confidenceGate: 0.5, // ignore unstable pitch frames
  rmsGate: 0.012
};

export function createSingSession() {
  return {
    mode: 'sing',
    stepIndex: 0,
    stepElapsed: 0,
    samples: [],
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

// Advance a singing session by one audio frame. Returns the (mutated) session
// plus a `captured` payload on the frame a syllable template is finalized.
export function feedSingFrame(session, live, dt) {
  if (session.done) return { session, captured: null, done: true };
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

  let captured = null;
  if (session.stepElapsed >= SING_CAPTURE.minDuration && session.samples.length >= SING_CAPTURE.minSamples) {
    const solfege = SOLFEGE[session.stepIndex];
    const template = buildSingingTemplate(solfege, session.samples);
    session.templates.push(template);
    captured = { solfege, template, stepIndex: session.stepIndex };
    session.stepIndex += 1;
    session.stepElapsed = 0;
    session.samples = [];
    if (session.stepIndex >= SOLFEGE.length) session.done = true;
  }
  return { session, captured, done: session.done };
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

  let result = null;
  if (session.elapsed >= PIANO_CAPTURE.minDuration && session.samples.length >= PIANO_CAPTURE.minSamples) {
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
