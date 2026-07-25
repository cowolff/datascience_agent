// Client-side persistence for the chat transcript, so a page reload doesn't
// wipe the conversation — same "never leaves the browser" principle as
// datasets.js's OPFS use, just a different browser storage API because the
// payload shape is different here (JSON-ish state, not raw file bytes).
//
// IndexedDB, not localStorage: a transcript can carry base64 plot images
// and chart/table data (up to render-chart.js's MAX_DATA_POINTS rows) that
// would blow past localStorage's ~5-10MB synchronous string quota, and
// structured-clone storage means the state object goes in as-is — no
// JSON.stringify/parse round trip needed.
//
// One record ("current") is overwritten on every save — this is a single-tab
// conversation cache, not a history of past sessions.

const DB_NAME = "bench-chat";
const DB_VERSION = 1;
const STORE = "state";
const KEY = "current";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveChatState(state) {
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadChatState() {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Backs the "Delete chat" button (workbench.js) — wipes the persisted
 * record so a reload doesn't bring the just-deleted conversation back. */
export async function clearChatState() {
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
