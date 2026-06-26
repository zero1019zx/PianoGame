import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPitchHold,
  detectPitchFromTimeDomain,
  midiToFrequency,
  pitchClassCentsToMidi,
  updatePitchHold
} from '../src/audioAnalysis.js';

function sineWave(frequency, sampleRate = 16000, length = 2048, amplitude = 0.5) {
  return Float32Array.from({ length }, (_, i) => Math.sin((i / sampleRate) * frequency * Math.PI * 2) * amplitude);
}

// Deterministic pseudo-noise so the "noise is rejected" test never flakes.
function noiseWave(sampleRate = 16000, length = 2048, seed = 12345) {
  let s = seed;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  return Float32Array.from({ length }, () => (rng() * 2 - 1) * 0.5);
}

test('detectPitchFromTimeDomain locks onto a steady tone with high clarity', () => {
  const out = detectPitchFromTimeDomain(sineWave(261.63), 16000);
  assert.ok(out.frequency, 'a clear tone should produce a pitch');
  assert.ok(Math.abs(out.frequency - 261.63) < 4, `frequency ~261.63, got ${out.frequency}`);
  assert.ok(out.confidence > 0.9, `confidence should be high, got ${out.confidence}`);
});

test('detectPitchFromTimeDomain returns NO pitch for noise (the old detector falsely did)', () => {
  const out = detectPitchFromTimeDomain(noiseWave(), 16000);
  assert.equal(out.frequency, null, 'noise must not yield a confident pitch');
  assert.ok(out.confidence < 0.9, `noise clarity should stay low, got ${out.confidence}`);
});

test('detectPitchFromTimeDomain returns no pitch for near-silence', () => {
  const out = detectPitchFromTimeDomain(sineWave(261.63, 16000, 2048, 0.002), 16000);
  assert.equal(out.frequency, null);
});

test('pitchClassCentsToMidi is octave-agnostic', () => {
  assert.ok(Math.abs(pitchClassCentsToMidi(midiToFrequency(60), 60)) < 1); // exact
  assert.ok(Math.abs(pitchClassCentsToMidi(midiToFrequency(72), 60)) < 1); // octave up still "Do"
  assert.ok(Math.abs(pitchClassCentsToMidi(midiToFrequency(48), 60)) < 1); // octave down
  assert.equal(Math.round(pitchClassCentsToMidi(midiToFrequency(67), 60)), -500); // G is 5 semis below C
});

test('pitch hold: a held on-target pitch registers a hit after minFrames', () => {
  const cfg = { targetMidi: 60, toleranceCents: 95, minFrames: 4 };
  let hold = createPitchHold();
  const onTarget = { frequency: midiToFrequency(60) };
  let hits = 0;
  for (let i = 0; i < 4; i += 1) {
    const r = updatePitchHold(hold, onTarget, cfg);
    hold = r.hold;
    if (r.hit) hits += 1;
  }
  assert.equal(hits, 1, 'exactly the 4th consecutive on-target frame should hit');
});

test('pitch hold: talking/noise (no voiced pitch) never hits', () => {
  const cfg = { targetMidi: 60, toleranceCents: 95, minFrames: 4 };
  let hold = createPitchHold();
  let anyHit = false;
  for (let i = 0; i < 60; i += 1) {
    const r = updatePitchHold(hold, { frequency: null }, cfg); // detector rejected → null
    hold = r.hold;
    anyHit = anyHit || r.hit;
  }
  assert.equal(anyHit, false);
});

test('pitch hold: a clearly wrong sung pitch never hits and keeps resetting', () => {
  const cfg = { targetMidi: 60, toleranceCents: 95, minFrames: 4 };
  let hold = createPitchHold();
  let anyHit = false;
  const wrong = { frequency: midiToFrequency(64) }; // Mi while target is Do, 400 cents off
  for (let i = 0; i < 60; i += 1) {
    const r = updatePitchHold(hold, wrong, cfg);
    hold = r.hold;
    anyHit = anyHit || r.hit;
  }
  assert.equal(anyHit, false);
});

test('pitch hold: a brief unvoiced breath only delays, does not reset', () => {
  const cfg = { targetMidi: 60, toleranceCents: 95, minFrames: 4 };
  let hold = createPitchHold();
  const on = { frequency: midiToFrequency(60) };
  const seq = [on, on, on, { frequency: null }, on, on]; // gap after 3
  let hitIndex = -1;
  seq.forEach((frame, i) => {
    const r = updatePitchHold(hold, frame, cfg);
    hold = r.hold;
    if (r.hit && hitIndex < 0) hitIndex = i;
  });
  assert.equal(hitIndex, 5, 'streak 3 → decay to 2 on the gap → 3 → 4 hits on the last frame');
});
