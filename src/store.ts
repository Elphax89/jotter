import type { Sheet, SheetMeta } from "./types";

/**
 * Local-only storage in IndexedDB. Nothing ever leaves the device.
 *  - "sheets":   saved sheets (what the list shows)
 *  - "index":    small list entries + thumbnail, so the list never loads stroke data
 *  - "recovery": the one unsaved working copy, only to survive a killed tab / reload
 */
const DB_NAME = "jotter";
const DB_VERSION = 3;

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const d = req.result;
        const tx = req.transaction!;
        if (!d.objectStoreNames.contains("sheets")) d.createObjectStore("sheets", { keyPath: "id" });
        if (!d.objectStoreNames.contains("index")) d.createObjectStore("index", { keyPath: "id" });
        if (!d.objectStoreNames.contains("recovery")) d.createObjectStore("recovery");
        if (ev.oldVersion >= 1 && ev.oldVersion < 3) {
          // Older versions autosaved everything. Keep every sheet, with its latest content, as saved.
          const touch = (name: "sheets" | "index") => {
            tx.objectStore(name).openCursor().onsuccess = (e) => {
              const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
              if (!cur) return;
              const v = cur.value as Sheet & { dirty?: boolean };
              v.name = v.name ?? "";
              v.savedAt = v.savedAt ?? v.updated;
              delete v.dirty;
              cur.update(v);
              cur.continue();
            };
          };
          touch("sheets");
          touch("index");
        }
        if (d.objectStoreNames.contains("saved")) d.deleteObjectStore("saved");
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

function toMeta(sheet: Sheet, thumb: Blob | undefined): SheetMeta {
  return {
    id: sheet.id,
    name: sheet.name,
    created: sheet.created,
    updated: sheet.updated,
    savedAt: sheet.savedAt,
    bg: sheet.bg,
    n: sheet.marks.length,
    thumb,
  };
}

/** Load a saved sheet. */
export async function loadSheet(id: string): Promise<Sheet | undefined> {
  const d = await db();
  const s = (await get(d.transaction("sheets").objectStore("sheets").get(id))) as Sheet | undefined;
  if (s) s.name = s.name ?? "";
  return s;
}

/**
 * Store a sheet in the list. `clearRecovery` also drops the unsaved working copy
 * (use it when the sheet being written is the one that is open).
 */
export async function persist(sheet: Sheet, opts: { thumb?: Blob; clearRecovery?: boolean } = {}) {
  const d = await db();
  const tx = d.transaction(["sheets", "index", "recovery"], "readwrite");
  tx.objectStore("sheets").put(sheet);
  if (opts.clearRecovery) tx.objectStore("recovery").delete("current");
  const index = tx.objectStore("index");
  const prev = (await get(index.get(sheet.id))) as SheetMeta | undefined;
  index.put(toMeta(sheet, opts.thumb ?? prev?.thumb));
  await done(tx);
}

/** Rename without touching strokes (works on sheets that aren't open). */
export async function renameSheet(id: string, name: string) {
  const d = await db();
  const tx = d.transaction(["sheets", "index"], "readwrite");
  for (const store of ["sheets", "index"] as const) {
    const os = tx.objectStore(store);
    const rec = (await get(os.get(id))) as { name: string } | undefined;
    if (rec) os.put({ ...rec, name });
  }
  await done(tx);
}

export async function listSheets(): Promise<SheetMeta[]> {
  const d = await db();
  const all = (await get(d.transaction("index").objectStore("index").getAll())) as SheetMeta[];
  for (const m of all) m.name = m.name ?? "";
  return all.sort((a, b) => b.updated - a.updated);
}

export async function deleteSheet(id: string) {
  const d = await db();
  const tx = d.transaction(["sheets", "index"], "readwrite");
  tx.objectStore("sheets").delete(id);
  tx.objectStore("index").delete(id);
  await done(tx);
}

export async function putRecovery(sheet: Sheet) {
  const d = await db();
  const tx = d.transaction("recovery", "readwrite");
  tx.objectStore("recovery").put(sheet, "current");
  await done(tx);
}

export async function loadRecovery(): Promise<Sheet | undefined> {
  const d = await db();
  const s = (await get(d.transaction("recovery").objectStore("recovery").get("current"))) as Sheet | undefined;
  if (s) s.name = s.name ?? "";
  return s;
}

export async function clearRecovery() {
  const d = await db();
  const tx = d.transaction("recovery", "readwrite");
  tx.objectStore("recovery").delete("current");
  await done(tx);
}

export function newId() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function newSheet(bg: string): Sheet {
  const now = Date.now();
  return { id: newId(), name: "", created: now, updated: now, bg, marks: [], view: { x: 0, y: 0, z: 1 } };
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
