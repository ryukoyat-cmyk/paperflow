const DB_NAME = 'paperflow-queue';
const DB_VERSION = 1;
const STORE = 'items';
const ACTIVE = new Set(['extract', 'ocr', 'glossary', 'draft', 'review', 'pdf']);

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let value;
      try { value = operation(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('작업 목록 저장을 취소했습니다.'));
    });
  } finally {
    db.close();
  }
}

export async function loadQueue() {
  const db = await openDb();
  try {
    const items = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    return items.sort((a, b) => a.order - b.order).map((item) => (
      ACTIVE.has(item.status)
        ? { ...item, status: 'queued', phase: 'queued', progress: 0, attempt: 0, error: '', recovered: true }
        : item
    ));
  } finally {
    db.close();
  }
}

export async function saveItem(item) {
  const record = structuredClone(item);
  await transaction('readwrite', (store) => store.put(record));
}

export async function deleteItem(id) {
  await transaction('readwrite', (store) => store.delete(id));
}

export async function clearQueue() {
  await transaction('readwrite', (store) => store.clear());
}

export async function hasStorageFor(bytes) {
  if (!navigator.storage?.estimate) return true;
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  return quota === 0 || quota - usage >= bytes * 1.2;
}
