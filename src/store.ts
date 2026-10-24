import type { Sheet, SheetMeta } from "./types";

/**
 * Local-only storage in IndexedDB. Nothing ever leaves the device.
 *  - "sheets": working copy of every sheet, autosaved while you draw
 *  - "saved":  snapshot from the last explicit "Save" (for revert / Save as)
 *  - "index":  small gallery entries + thumbnail, so the gallery never loads stroke data
 */
const DB_NAME = "jotter";
const DB_VERSION = 2;

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
        if (!d.objectStoreNames.contains("saved")) d.createObjectStore("saved", { keyPath: "id" });
        if (ev.oldVersion === 1) {
          // v1 had autosave only: treat every existing sheet as saved.
          const sheets = tx.objectStore("sheets");
          const saved = tx.objectStore("saved");
          const index = tx.objectStore("index");
          sheets.openCursor().onsuccess = (e) => {
            const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cur) return;
            const s = cur.value as Sheet;
            s.name = s.name ?? "";
            s.savedAt = s.updated;
            s.dirty = false;
            cur.update(s);
            saved.put(s);
            cur.continue();
          };
          index.openCursor().onsuccess = (e) => {
            const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cur) return;
            const m = cur.value as SheetMeta;
            m.name = m.name ?? "";
            m.savedAt = m.updated;
            m.dirty = false;
            cur.update(m);
            cur.continue();
          };
        }
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
    dirty: sheet.dirty,
    bg: sheet.bg,
    n: sheet.marks.length,
    thumb,
  };
}

/** Load the working copy (what you see when you open a sheet). */
export async function loadSheet(id: string): Promise<Sheet | undefined> {
  const d = await db();
  const s = (await get(d.transaction("sheets").objectStore("sheets").get(id))) as Sheet | undefined;
  if (s) s.name = s.name ?? "";
  return s;
}

/** Load the snapshot of the last explicit save. */
export async function loadSaved(id: string): Promise<Sheet | undefined> {
  const d = await db();
  return get(d.transaction("saved").objectStore("saved").get(id)) as Promise<Sheet | undefined>;
}

/**
 * Write a sheet. `commit` also stores the snapshot ("Save").
 * Without `commit` only the working copy is updated (autosave).
 */
export async function persist(sheet: Sheet, opts: { commit?: boolean; thumb?: Blob } = {}) {
  const d = await db();
  const tx = d.transaction(["sheets", "saved", "index"], "readwrite");
  tx.objectStore("sheets").put(sheet);
  if (opts.commit) tx.objectStore("saved").put(sheet);
  const index = tx.objectStore("index");
  const prev = (await get(index.get(sheet.id))) as SheetMeta | undefined;
  index.put(toMeta(sheet, opts.thumb ?? prev?.thumb));
  await done(tx);
}

/** Rename without touching strokes (works on sheets that aren't open). */
export async function renameSheet(id: string, name: string) {
  const d = await db();
  const tx = d.transaction(["sheets", "saved", "index"], "readwrite");
  for (const store of ["sheets", "saved", "index"] as const) {
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
  const tx = d.transaction(["sheets", "saved", "index"], "readwrite");
  tx.objectStore("sheets").delete(id);
  tx.objectStore("saved").delete(id);
  tx.objectStore("index").delete(id);
  await done(tx);
}

export function newId() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function newSheet(bg: string): Sheet {
  const now = Date.now();
  return { id: newId(), name: "", created: now, updated: now, dirty: false, bg, marks: [], view: { x: 0, y: 0, z: 1 } };
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
