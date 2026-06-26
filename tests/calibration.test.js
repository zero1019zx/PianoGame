import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SING_CAPTURE,
  createPianoSession,
  createSingSession,
  feedPianoFrame,
  feedSingFrame,
  forceCaptureSing,
  persistPianoCalibration,
  persistSingCalibration,
  singProgress
} from '../src/calibration.js';
import {
  SOLFEGE,
  createMemoryCalibrationStore,
  loadCalibrationState
} from '../src/notationGame.js';
import { midiToFrequency } from '../src/audioAnalysis.js';

// Synthesize one steady "voice" frame with a fresh MFCC id each call so the
// session treats it as new captured audio.
function voiceFrame(id, midi = 60) {
  return {
    frequency: midiToFrequency(midi),
    midi,
    rms: 0.05,
    confidence: 0.85,
    mfcc: [id % 5, 1, 0.5, 0.2],
    mfccFrameId: id
  };
}

test('singing session captures a multi-take template per syllable and finishes after Si', () => {
  const session = createSingSession();
  let syllables = 0;
  let frameId = 1;

  for (let i = 0; i < SOLFEGE.length * 80 && !session.done; i += 1) {
    const { syllableDone } = feedSingFrame(session, voiceFrame(frameId), 0.12);
    frameId += 1;
    if (syllableDone) {
      syllables += 1;
      assert.equal(syllableDone.template.completed, true);
      assert.equal(syllableDone.template.takes.length, 2, 'each syllable keeps both takes');
    }
  }

  assert.equal(session.done, true);
  assert.equal(syllables, SOLFEGE.length);
  assert.equal(session.templates.length, SOLFEGE.length);
  assert.equal(singProgress(session).completed, SOLFEGE.length);
});

test('two takes complete a syllable; manual next finalizes one take at a time', () => {
  const session = createSingSession();
  feedSingFrame(session, voiceFrame(1), 0.12);
  feedSingFrame(session, voiceFrame(2), 0.12);

  let out = forceCaptureSing(session);
  assert.ok(out.takeCaptured, 'first take finalized');
  assert.equal(out.syllableDone, null, 'syllable not done after one take');
  assert.equal(session.takeIndex, 1);
  assert.equal(session.stepIndex, 0);

  feedSingFrame(session, voiceFrame(3), 0.12);
  feedSingFrame(session, voiceFrame(4), 0.12);
  out = forceCaptureSing(session);
  assert.ok(out.syllableDone, 'syllable completes after the second take');
  assert.equal(out.syllableDone.template.takes.length, 2);
  assert.equal(session.stepIndex, 1);
});

test('singing capture auto-finalizes a take after maxDuration so it never stalls', () => {
  const session = createSingSession();
  for (let i = 1; i <= 3; i += 1) feedSingFrame(session, voiceFrame(i), 0.12);
  let takeCaptured = null;
  for (let i = 0; i < 30 && !takeCaptured; i += 1) {
    const out = feedSingFrame(session, { rms: 0, mfcc: null, mfccFrameId: 100 + i }, 0.12);
    takeCaptured = out.takeCaptured;
  }
  assert.ok(takeCaptured, 'should auto-finalize a take from the few captured samples');
  assert.equal(session.takeIndex, 1);
});

test('singing session ignores quiet frames below the rms gate', () => {
  const session = createSingSession();
  const quiet = { frequency: 261, midi: 60, rms: SING_CAPTURE.rmsGate - 0.005, confidence: 0.9, mfcc: [1, 1], mfccFrameId: 1 };

  for (let i = 0; i < 30; i += 1) {
    quiet.mfccFrameId = i + 1;
    feedSingFrame(session, quiet, 0.12);
  }

  assert.equal(session.samples.length, 0);
  assert.equal(session.stepIndex, 0);
});

test('piano session computes a central-C tuning offset from a slightly sharp piano', () => {
  const session = createPianoSession();
  const sharpC = midiToFrequency(60) * (2 ** (12 / 1200)); // +12 cents
  let result = null;

  for (let i = 0; i < 40 && !session.done; i += 1) {
    const out = feedPianoFrame(session, { frequency: sharpC, confidence: 0.8, rms: 0.05 }, 0.12);
    result = out.result ?? result;
  }

  assert.equal(session.done, true);
  assert.ok(result, 'capture should complete');
  assert.equal(result.referenceMidi, 60);
  assert.equal(result.centralCOffsetCents, 12);
});

test('persisting calibration writes a record games can read back', () => {
  const store = createMemoryCalibrationStore();
  const templates = SOLFEGE.map((solfege) => ({ solfege, completed: true, mfccSequence: [[1, 1]] }));

  persistSingCalibration(store, templates, '宝宝');
  persistPianoCalibration(store, { centralCOffsetCents: -8, referenceMidi: 60 });

  const sing = loadCalibrationState(store, 'sing');
  const play = loadCalibrationState(store, 'play');

  assert.equal(sing.completed, true);
  assert.equal(sing.templates.length, SOLFEGE.length);
  assert.equal(sing.profileName, '宝宝');
  assert.equal(play.completed, true);
  assert.equal(play.centralCOffsetCents, -8);
});
