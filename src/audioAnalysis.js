const A4_MIDI = 69;
const A4_FREQUENCY = 440;

export function midiToFrequency(midi) {
  return A4_FREQUENCY * (2 ** ((midi - A4_MIDI) / 12));
}

export function frequencyToMidi(frequency) {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  return Math.round(A4_MIDI + 12 * Math.log2(frequency / A4_FREQUENCY));
}

export function centsBetween(referenceFrequency, detectedFrequency) {
  if (!referenceFrequency || !detectedFrequency) return Infinity;
  return 1200 * Math.log2(detectedFrequency / referenceFrequency);
}

export function classifyEnvironment({ rms, confidence }) {
  if (rms < 0.012) {
    return { status: 'quiet', label: '环境安静，等待声音', score: 0.35 };
  }
  if (rms > 0.14 && confidence < 0.45) {
    return { status: 'noisy', label: '环境偏吵，靠近麦克风', score: 0.45 };
  }
  if (confidence >= 0.65 && rms >= 0.018) {
    return { status: 'good', label: '环境安静，信号良好', score: 0.95 };
  }
  return { status: 'listening', label: '正在监听声音', score: 0.7 };
}

export function buildSingingTemplate(solfege, samples) {
  const usableMfcc = samples
    .map((sample) => sample.mfcc)
    .filter((mfcc) => Array.isArray(mfcc) && mfcc.length > 0 && mfcc.every(Number.isFinite));
  const usable = samples.filter((sample) => sample.frequency && sample.confidence >= 0.45);
  if (usableMfcc.length > 0) {
    const pitchSamples = usable.length > 0 ? usable : samples.filter((sample) => sample.frequency);
    const averageFrequency = pitchSamples.length > 0
      ? pitchSamples.reduce((sum, sample) => sum + sample.frequency, 0) / pitchSamples.length
      : null;
    return {
      solfege,
      completed: true,
      frequency: averageFrequency,
      midi: averageFrequency ? frequencyToMidi(averageFrequency) : null,
      mfccSequence: usableMfcc,
      samples: usableMfcc.length
    };
  }
  if (usable.length === 0) {
    return { solfege, completed: false, samples: [] };
  }
  const averageFrequency = usable.reduce((sum, sample) => sum + sample.frequency, 0) / usable.length;
  const averageRms = usable.reduce((sum, sample) => sum + sample.rms, 0) / usable.length;
  const averageConfidence = usable.reduce((sum, sample) => sum + sample.confidence, 0) / usable.length;
  return {
    solfege,
    completed: true,
    frequency: averageFrequency,
    midi: frequencyToMidi(averageFrequency),
    rms: averageRms,
    confidence: averageConfidence,
    samples: usable.length
  };
}

export function matchDetectedPitch({
  targetMidi,
  detectedFrequency,
  centralCOffsetCents = 0,
  toleranceCents = 65
}) {
  const adjustedTargetFrequency = midiToFrequency(targetMidi) * (2 ** (centralCOffsetCents / 1200));
  const cents = centsBetween(adjustedTargetFrequency, detectedFrequency);
  const midi = frequencyToMidi(detectedFrequency * (2 ** (-centralCOffsetCents / 1200)));
  return {
    correct: Math.abs(cents) <= toleranceCents,
    cents,
    midi,
    targetMidi
  };
}

export function matchSingingTemplate({
  detectedFrequency,
  detectedMfccSequence,
  templates,
  toleranceCents = 120,
  tolerance = 18
}) {
  const mfccTemplates = templates.filter((template) => (
    template.completed
    && ((Array.isArray(template.takes) && template.takes.length > 0)
      || (Array.isArray(template.mfccSequence) && template.mfccSequence.length > 0))
  ));
  if (Array.isArray(detectedMfccSequence) && detectedMfccSequence.length > 0 && mfccTemplates.length > 0) {
    const best = mfccTemplates
      .map((template) => {
        // Match against each take of this syllable and keep the closest one.
        const sequences = (Array.isArray(template.takes) && template.takes.length > 0)
          ? template.takes
          : [template.mfccSequence];
        const distance = Math.min(...sequences.map((seq) => dtwDistance(detectedMfccSequence, seq)));
        return { template, distance };
      })
      .sort((a, b) => a.distance - b.distance)[0];

    return {
      correct: best.distance <= tolerance,
      solfege: best.template.solfege,
      distance: best.distance,
      template: best.template,
      method: 'mfcc-dtw'
    };
  }

  const usable = templates.filter((template) => template.completed && template.frequency);
  if (!detectedFrequency || usable.length === 0) {
    return { correct: false, solfege: null, cents: Infinity };
  }

  const best = usable
    .map((template) => ({
      template,
      cents: centsBetween(template.frequency, detectedFrequency)
    }))
    .sort((a, b) => Math.abs(a.cents) - Math.abs(b.cents))[0];

  return {
    correct: Math.abs(best.cents) <= toleranceCents,
    solfege: best.template.solfege,
    cents: best.cents,
    template: best.template,
    method: 'pitch-fallback'
  };
}

export function extractMfcc(samples, sampleRate, {
  coefficientCount = 13,
  filterCount = 24,
  frameSize = 1024,
  minHz = 80,
  maxHz = 4200
} = {}) {
  const frame = Array.from(samples.slice(0, Math.min(frameSize, samples.length)));
  while (frame.length < frameSize) frame.push(0);
  const windowed = frame.map((sample, index) => {
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (frameSize - 1));
    return sample * window;
  });
  const powerSpectrum = computePowerSpectrum(windowed);
  return mfccFromPowerSpectrum(powerSpectrum, sampleRate, {
    coefficientCount,
    filterCount,
    minHz,
    maxHz
  });
}

export function mfccFromPowerSpectrum(powerSpectrum, sampleRate, {
  coefficientCount = 13,
  filterCount = 24,
  minHz = 80,
  maxHz = 4200
} = {}) {
  const filters = createMelFilterBank({
    filterCount,
    binCount: powerSpectrum.length,
    sampleRate,
    minHz,
    maxHz: Math.min(maxHz, sampleRate / 2)
  });
  const logEnergies = filters.map((filter) => {
    let energy = 0;
    for (let index = 0; index < filter.length; index += 1) {
      energy += powerSpectrum[index] * filter[index];
    }
    return Math.log(Math.max(energy, 1e-12));
  });
  return discreteCosineTransform(logEnergies).slice(0, coefficientCount);
}

export function dtwDistance(sequenceA, sequenceB) {
  if (!sequenceA.length || !sequenceB.length) return Infinity;
  const rows = sequenceA.length + 1;
  const cols = sequenceB.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(Infinity));
  dp[0][0] = 0;
  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = euclideanDistance(sequenceA[row - 1], sequenceB[col - 1]);
      dp[row][col] = cost + Math.min(
        dp[row - 1][col],
        dp[row][col - 1],
        dp[row - 1][col - 1]
      );
    }
  }
  return dp[sequenceA.length][sequenceB.length] / (sequenceA.length + sequenceB.length);
}

export function detectPitchFromTimeDomain(samples, sampleRate) {
  const rms = rootMeanSquare(samples);
  if (rms < 0.01) return { frequency: null, confidence: 0, rms };

  let bestOffset = -1;
  let bestCorrelation = 0;
  const minFrequency = 120;
  const maxFrequency = 900;
  const minOffset = Math.floor(sampleRate / maxFrequency);
  const maxOffset = Math.min(Math.floor(sampleRate / minFrequency), Math.floor(samples.length / 2));

  for (let offset = minOffset; offset <= maxOffset; offset += 1) {
    let correlation = 0;
    for (let index = 0; index < samples.length - offset; index += 1) {
      correlation += 1 - Math.abs(samples[index] - samples[index + offset]);
    }
    correlation /= samples.length - offset;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestOffset = offset;
    }
  }

  if (bestOffset <= 0 || bestCorrelation < 0.35) {
    return { frequency: null, confidence: bestCorrelation, rms };
  }

  return {
    frequency: sampleRate / bestOffset,
    confidence: Math.min(1, Math.max(0, bestCorrelation)),
    rms
  };
}

export function rootMeanSquare(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function computePowerSpectrum(frame) {
  const binCount = Math.floor(frame.length / 2) + 1;
  const spectrum = new Array(binCount).fill(0);
  for (let bin = 0; bin < binCount; bin += 1) {
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < frame.length; index += 1) {
      const angle = (2 * Math.PI * bin * index) / frame.length;
      real += frame[index] * Math.cos(angle);
      imaginary -= frame[index] * Math.sin(angle);
    }
    spectrum[bin] = (real * real + imaginary * imaginary) / frame.length;
  }
  return spectrum;
}

function createMelFilterBank({ filterCount, binCount, sampleRate, minHz, maxHz }) {
  const minMel = hzToMel(minHz);
  const maxMel = hzToMel(maxHz);
  const melPoints = Array.from({ length: filterCount + 2 }, (_, index) => (
    minMel + ((maxMel - minMel) * index) / (filterCount + 1)
  ));
  const hzPoints = melPoints.map(melToHz);
  const bins = hzPoints.map((hz) => Math.floor(((binCount - 1) * 2 * hz) / sampleRate));
  return Array.from({ length: filterCount }, (_, filterIndex) => {
    const filter = new Array(binCount).fill(0);
    const left = bins[filterIndex];
    const center = Math.max(left + 1, bins[filterIndex + 1]);
    const right = Math.max(center + 1, bins[filterIndex + 2]);
    for (let bin = left; bin < center && bin < binCount; bin += 1) {
      filter[bin] = (bin - left) / (center - left);
    }
    for (let bin = center; bin < right && bin < binCount; bin += 1) {
      filter[bin] = (right - bin) / (right - center);
    }
    return filter;
  });
}

function discreteCosineTransform(values) {
  const count = values.length;
  return values.map((_, coefficient) => {
    let sum = 0;
    for (let index = 0; index < count; index += 1) {
      sum += values[index] * Math.cos((Math.PI * coefficient * (index + 0.5)) / count);
    }
    return sum;
  });
}

function euclideanDistance(vectorA, vectorB) {
  const length = Math.min(vectorA.length, vectorB.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const delta = vectorA[index] - vectorB[index];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel) {
  return 700 * ((10 ** (mel / 2595)) - 1);
}
