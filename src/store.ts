import type { Sheet, SheetMeta } from "./types";

/**
 * Local-only storage in IndexedDB. Nothing ever leaves the device.
 *  - "sheets": full sheet data (marks)
 *  - "index":  small gallery entries + thumbnail, so the gallery never loads stroke data
 */
const DB_NAME = "jotter";
const DB_VERSION = 1;

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("sheets")) d.createObjectStore("sheets", { keyPath: "id" });
        if (!d.objectStoreNames.contains("index")) d.createObjectStore("index", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    });
    dbp.catch(() => (dbp = null));
  }
  return dbp;
}

function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function get<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadSheet(id: string): Promise<Sheet | undefined> {
  const d = await db();
  return get(d.transaction("sheets").objectStore("sheets").get(id)) as Promise<Sheet | undefined>;
}

export async function saveSheet(sheet: Sheet, thumb?: Blob) {
  const d = await db();
  const tx = d.transaction(["sheets", "index"], "readwrite");
  tx.objectStore("sheets").put(sheet);
  const index = tx.objectStore("index");
  const prev = (await get(index.get(sheet.id))) as SheetMeta | undefined;
  const meta: SheetMeta = {
    id: sheet.id,
    created: sheet.created,
    updated: sheet.updated,
    bg: sheet.bg,
    n: sheet.marks.length,
    thumb: thumb ?? prev?.thumb,
  };
  index.put(meta);
  await done(tx);
}

export async function listSheets(): Promise<SheetMeta[]> {
  const d = await db();
  const all = (await get(d.transaction("index").objectStore("index").getAll())) as SheetMeta[];
  return all.sort((a, b) => b.updated - a.updated);
}

export async function deleteSheet(id: string) {
  const d = await db();
  const tx = d.transaction(["sheets", "index"], "readwrite");
  tx.objectStore("sheets").delete(id);
  tx.objectStore("index").delete(id);
  await done(tx);
}

export function newSheet(bg: string): Sheet {
  const now = Date.now();
  return {
    id: crypto.randomUUID?.() ?? `${now.toString(36)}-${Math.random().toString(36).slice(2)}`,
    created: now,
    updated: now,
    bg,
    marks: [],
    view: { x: 0, y: 0, z: 1 },
  };
}

/** Ask the browser not to evict our data under storage pressure. */
export function requestPersistence() {
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* unsupported */
  }
}

// Small per-device preferences (tool, colour, …) — convenience only.
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`jotter.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`jotter.${key}`, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}
