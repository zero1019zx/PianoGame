import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSingingTemplate,
  centsBetween,
  classifyEnvironment,
  dtwDistance,
  extractMfcc,
  frequencyToMidi,
  matchSingingTemplate,
  matchDetectedPitch,
  midiToFrequency
} from '../src/audioAnalysis.js';

function sineWave(frequency, sampleRate = 16000, length = 1024) {
  return Float32Array.from({ length }, (_, index) => Math.sin((index / sampleRate) * frequency * Math.PI * 2) * 0.6);
}

test('frequency and midi conversion keeps central C stable', () => {
  assert.equal(frequencyToMidi(261.63), 60);
  assert.equal(Math.round(midiToFrequency(60) * 100) / 100, 261.63);
  assert.equal(Math.round(centsBetween(261.63, 263.14)), 10);
});

test('environment classification reflects signal level and pitch confidence', () => {
  assert.equal(classifyEnvironment({ rms: 0.004, confidence: 0 }).status, 'quiet');
  assert.equal(classifyEnvironment({ rms: 0.18, confidence: 0.1 }).status, 'noisy');
  assert.equal(classifyEnvironment({ rms: 0.06, confidence: 0.82 }).status, 'good');
});

test('singing template averages captured samples for known solfege', () => {
  const template = buildSingingTemplate('Do', [
    { frequency: 261.63, rms: 0.06, confidence: 0.9 },
    { frequency: 262.2, rms: 0.05, confidence: 0.8 }
  ]);

  assert.equal(template.solfege, 'Do');
  assert.equal(template.midi, 60);
  assert.equal(template.completed, true);
});

test('extractMfcc returns finite cepstral coefficients from a voice-like frame', () => {
  const mfcc = extractMfcc(sineWave(261.63), 16000, { coefficientCount: 13 });

  assert.equal(mfcc.length, 13);
  assert.ok(mfcc.every(Number.isFinite));
});

test('dtwDistance is zero for identical feature sequences and larger for different ones', () => {
  const sequence = [[1, 0.5], [1.2, 0.4], [0.8, 0.3]];
  const shifted = [[3, 2.5], [3.2, 2.4], [2.8, 2.3]];

  assert.equal(dtwDistance(sequence, sequence), 0);
  assert.ok(dtwDistance(sequence, shifted) > 1);
});

test('detected pitch matches target with piano central-C calibration offset', () => {
  const result = matchDetectedPitch({
    targetMidi: 64,
    detectedFrequency: midiToFrequency(64) * 1.006,
    centralCOffsetCents: -10,
    toleranceCents: 45
  });

  assert.equal(result.correct, true);
  assert.equal(result.midi, 64);
});

test('singing template matching picks the closest calibrated solfege', () => {
  const result = matchSingingTemplate({
    detectedFrequency: midiToFrequency(62) * 1.01,
    templates: [
      { solfege: 'Do', frequency: midiToFrequency(60), completed: true },
      { solfege: 'Re', frequency: midiToFrequency(62), completed: true },
      { solfege: 'Mi', frequency: midiToFrequency(64), completed: true }
    ],
    toleranceCents: 80
  });

  assert.equal(result.solfege, 'Re');
  assert.equal(result.correct, true);
});

test('singing template matching scores against the closest take of each syllable', () => {
  const result = matchSingingTemplate({
    detectedMfccSequence: [[4, 2, 1], [4.1, 2.1, 1.1]],
    templates: [
      { solfege: 'Do', completed: true, takes: [[[0, 0, 0]], [[0.1, 0, 0]]] },
      { solfege: 'Re', completed: true, takes: [[[9, 9, 9]], [[4, 2, 1], [4.1, 2, 1.1]]] },
      { solfege: 'Mi', completed: true, takes: [[[8, 4, 2]]] }
    ],
    tolerance: 1.5
  });

  assert.equal(result.solfege, 'Re');
  assert.equal(result.correct, true);
  assert.equal(result.method, 'mfcc-dtw');
});

test('singing template matching prefers MFCC DTW when feature sequences are available', () => {
  const result = matchSingingTemplate({
    detectedMfccSequence: [[4, 2, 1], [4.1, 2.1, 1.1], [3.9, 1.9, 1]],
    templates: [
      { solfege: 'Do', completed: true, mfccSequence: [[0, 0, 0], [0.1, 0, 0]] },
      { solfege: 'Re', completed: true, mfccSequence: [[4, 2, 1], [4.1, 2, 1.1]] },
      { solfege: 'Mi', completed: true, mfccSequence: [[8, 4, 2], [8.2, 4.1, 2]] }
    ],
    tolerance: 1.3
  });

  assert.equal(result.solfege, 'Re');
  assert.equal(result.correct, true);
  assert.equal(result.method, 'mfcc-dtw');
});
