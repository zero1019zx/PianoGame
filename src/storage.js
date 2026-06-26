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
  if (typeof indexedDB === 'undefined') return null;

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

// Durable snapshot of a child's calibration record, kept alongside the fast
// localStorage cache so later sessions keep the more accurate templates.
export async function saveCalibrationProfile(profile, id = 'default') {
  const db = await openProfileDatabase().catch(() => null);
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('profiles', 'readwrite');
    tx.objectStore('profiles').put({ id, ...profile, savedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadCalibrationProfile(id = 'default') {
  const db = await openProfileDatabase().catch(() => null);
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('profiles', 'readonly');
    const request = tx.objectStore('profiles').get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function keyFor(mode) {
  return `${CALIBRATION_PREFIX}${mode}`;
}

