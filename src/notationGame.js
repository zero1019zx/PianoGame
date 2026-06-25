export const MODES = {
  sing: {
    id: 'sing',
    label: '唱谱模式',
    calibrationLabel: '录入 Do Re Mi 的发音'
  },
  play: {
    id: 'play',
    label: '弹谱模式',
    calibrationLabel: '弹一次中央 C'
  }
};

export const SOLFEGE = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Si'];

export const BUILT_IN_SONG = {
  id: 'first-steps-c',
  title: '小星星上楼梯',
  tempo: 96,
  notes: [
    note('n1', 'Do', 60, 0, 1, 500),
    note('n2', 'Re', 62, 1, 1, 500),
    note('n3', 'Mi', 64, 2, 1, 500),
    note('n4', 'Fa', 65, 3, 1, 500),
    note('n5', 'Sol', 67, 4, 1, 700),
    note('n6', 'Mi', 64, 2, 1, 500),
    note('n7', 'Re', 62, 1, 1, 500),
    note('n8', 'Do', 60, 0, 2, 900)
  ]
};

export function createGame({ mode = 'sing', song = BUILT_IN_SONG } = {}) {
  return {
    mode,
    phase: 'aiming',
    song,
    currentIndex: 0,
    score: 0,
    streak: 0,
    attempts: 0,
    placedNotes: [],
    mistakes: [],
    feedback: '看气球上的音，准备发射音符',
    balloon: createBalloon(song.notes[0]),
    projectile: null,
    playbackStartedAt: null
  };
}

export function createMemoryCalibrationStore(initial = {}) {
  const records = new Map(Object.entries(initial));
  return {
    get(mode) {
      return records.get(mode) ?? null;
    },
    set(mode, value) {
      records.set(mode, value);
    },
    delete(mode) {
      records.delete(mode);
    }
  };
}

export function loadCalibrationState(store, mode) {
  const cached = store.get(mode);
  if (!cached) return defaultCalibration(mode);
  return { ...defaultCalibration(mode), ...cached };
}

export function submitCalibration(store, mode, payload = {}) {
  const record = {
    ...defaultCalibration(mode),
    ...payload,
    completed: true,
    calibratedAt: new Date().toISOString()
  };
  store.set(mode, record);
  return record;
}

export function resetCalibration(store, mode) {
  store.delete(mode);
  return defaultCalibration(mode);
}

export function getCurrentTarget(game) {
  return game.song.notes[game.currentIndex] ?? null;
}

export function submitInput(game, input) {
  const target = getCurrentTarget(game);
  if (!target || game.phase === 'playback') {
    return { correct: false, effect: 'done' };
  }

  game.attempts += 1;
  const correct = isCorrectInput(target, input);

  if (!correct) {
    game.streak = 0;
    const mistake = {
      noteId: target.id,
      expected: expectedForMode(game.mode, target),
      received: receivedForMode(game.mode, input),
      attempt: game.attempts
    };
    game.mistakes.push(mistake);
    game.feedback = '差一点，再试一次';
    return { correct: false, effect: 'try-again', mistake };
  }

  game.score += 100 + game.streak * 10;
  game.streak += 1;
  game.phase = 'burst';
  game.feedback = `${target.solfege} 命中，音符回到五线谱`;
  game.balloon = { ...game.balloon, state: 'placed' };
  game.projectile = {
    noteId: target.id,
    from: 'launcher',
    to: 'staff',
    state: 'arrived'
  };
  game.placedNotes.push({ ...target, mode: game.mode, placedAtAttempt: game.attempts });
  game.currentIndex += 1;

  const nextTarget = getCurrentTarget(game);
  if (nextTarget) {
    game.phase = 'burst';
  } else {
    game.phase = 'playback';
    game.feedback = '全曲完成，听一遍你的旋律';
    game.balloon = null;
  }

  return { correct: true, effect: 'burst', target };
}

export function settleBurst(game) {
  if (game.phase !== 'burst') return game;
  const nextTarget = getCurrentTarget(game);
  if (!nextTarget) {
    game.phase = 'playback';
    game.balloon = null;
    return game;
  }
  game.phase = 'aiming';
  game.balloon = createBalloon(nextTarget);
  game.projectile = null;
  return game;
}

export function getPlaybackEvents(game) {
  let at = 0;
  return game.song.notes.map((songNote) => {
    const event = {
      at,
      solfege: songNote.solfege,
      midi: songNote.midi,
      duration: songNote.duration
    };
    at += songNote.duration;
    return event;
  });
}

export function staffYForNote(noteData) {
  return 250 - noteData.staffStep * 18;
}

export function modeInputOptions(mode, target) {
  if (mode === 'sing') {
    return SOLFEGE.map((solfege) => ({
      label: solfege,
      value: solfege,
      correct: solfege === target.solfege
    }));
  }
  return [
    { label: '中央 C', value: 60 },
    { label: 'D', value: 62 },
    { label: 'E', value: 64 },
    { label: 'F', value: 65 },
    { label: 'G', value: 67 },
    { label: 'A', value: 69 },
    { label: 'B', value: 71 }
  ].map((option) => ({ ...option, correct: option.value === target.midi }));
}

function defaultCalibration(mode) {
  if (mode === 'sing') {
    return {
      mode,
      completed: false,
      syllables: [],
      profileName: '小朋友'
    };
  }
  return {
    mode,
    completed: false,
    centralCOffsetCents: 0,
    referenceMidi: 60
  };
}

function isCorrectInput(target, input) {
  if (input.mode === 'sing') {
    return normalizeSolfege(input.solfege) === normalizeSolfege(target.solfege);
  }
  if (input.mode === 'play') {
    return Number(input.midi) === target.midi;
  }
  return false;
}

function normalizeSolfege(value) {
  return String(value ?? '').trim().toLowerCase();
}

function expectedForMode(mode, target) {
  return mode === 'play' ? target.midi : target.solfege;
}

function receivedForMode(mode, input) {
  return mode === 'play' ? input.midi : input.solfege;
}

function createBalloon(songNote) {
  return {
    id: `balloon-${songNote.id}`,
    noteId: songNote.id,
    solfege: songNote.solfege,
    state: 'floating'
  };
}

function note(id, solfege, midi, staffStep, beat, duration) {
  return { id, solfege, midi, staffStep, beat, duration };
}
