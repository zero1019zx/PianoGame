import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  createMemoryCalibrationStore,
  getCurrentTarget,
  getPlaybackEvents,
  loadCalibrationState,
  resetCalibration,
  submitCalibration,
  submitInput
} from '../src/notationGame.js';

test('loads separate cached calibration state for singing and piano modes', () => {
  const store = createMemoryCalibrationStore({
    sing: { completed: true, syllables: ['Do', 'Re', 'Mi'] },
    play: { completed: false }
  });

  assert.equal(loadCalibrationState(store, 'sing').completed, true);
  assert.equal(loadCalibrationState(store, 'play').completed, false);

  submitCalibration(store, 'play', { centralCOffsetCents: -8 });
  assert.equal(loadCalibrationState(store, 'play').completed, true);
  assert.equal(loadCalibrationState(store, 'play').centralCOffsetCents, -8);

  resetCalibration(store, 'sing');
  assert.equal(loadCalibrationState(store, 'sing').completed, false);
});

test('correct singing input bursts the balloon and places the note on the staff', () => {
  const game = createGame({ mode: 'sing' });
  const target = getCurrentTarget(game);

  const result = submitInput(game, { mode: 'sing', solfege: target.solfege });

  assert.equal(result.correct, true);
  assert.equal(result.effect, 'burst');
  assert.equal(game.score, 100);
  assert.equal(game.placedNotes.length, 1);
  assert.equal(game.placedNotes[0].id, target.id);
  assert.equal(game.balloon.state, 'placed');
});

test('wrong input marks a gentle mistake without advancing the target', () => {
  const game = createGame({ mode: 'play' });
  const target = getCurrentTarget(game);

  const result = submitInput(game, { mode: 'play', midi: target.midi + 2 });

  assert.equal(result.correct, false);
  assert.equal(result.effect, 'try-again');
  assert.equal(game.currentIndex, 0);
  assert.equal(game.mistakes.length, 1);
  assert.equal(getCurrentTarget(game).id, target.id);
});

test('finishing the built-in song enters playback and exposes rhythm events', () => {
  const game = createGame({ mode: 'sing' });

  while (game.phase !== 'playback') {
    const target = getCurrentTarget(game);
    submitInput(game, { mode: 'sing', solfege: target.solfege });
  }

  const events = getPlaybackEvents(game);
  assert.equal(game.phase, 'playback');
  assert.equal(events.length, game.song.notes.length);
  assert.deepEqual(events[0], {
    at: 0,
    solfege: 'Do',
    midi: 60,
    duration: 500
  });
});

