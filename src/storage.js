const CALIBRATION_PREFIX = 'notation-mvp-calibration:';

export function createBrowserCalibrationStore(storage = window.localStorage) {
  return {
    get(mode) {
      const raw = storage.getItem(keyFor(mode));
      return raw ? JSON.parse(raw) : null;
    },
    set(mode, value) {
      storage.setItem(keyFor(mode), JSON.stringify(value));
    },
    delete(mode) {
      storage.removeItem(keyFor(mode));
    }
  };
}

export async function openProfileDatabase() {
  if (!('indexedDB' in window)) return null;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open('notation-mvp-profiles', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('profiles')) {
        db.createObjectStore('profiles', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function keyFor(mode) {
  return `${CALIBRATION_PREFIX}${mode}`;
}

