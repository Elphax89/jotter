import "./styles.css";
import { Board } from "./board";
import { t, translateDom, LANG } from "./i18n";
import { attachInput, isTyping, type Brush } from "./input";
import { renderRegion, union } from "./render";
import { clearRecovery, deleteSheet, listSheets, loadRecovery, loadSheet, newId, newSheet, persist, putRecovery, readPref, renameSheet, requestPersistence, writePref } from "./store";
import type { BBox, ShapeKind, Sheet, SheetMeta, Tool } from "./types";

// ------------------------------------------------------------------ palette

const INKS = ["#1c1917", "#f4f1ea", "#8a8580", "#e5484d", "#f76b15", "#ffc53d", "#46a758", "#2f5d50", "#0090ff", "#3c4f72", "#8e4ec6", "#d6409f", "#8f5a3c", "#8f3d2c"];
const PAPERS = ["#f3efe6", "#fbfbfb", "#e4eaee", "#efe4d4", "#1c1917"];

const SIZE_RANGE: Record<Tool, [number, number, number[]]> = {
  pen: [1, 64, [2, 5, 10, 20, 40]],
  shape: [1, 40, [2, 4, 8, 14, 24]],
  eraser: [6, 140, [12, 24, 48, 80, 120]],
  text: [12, 120, [16, 24, 36, 56, 80]],
};

// ------------------------------------------------------------------ dom

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const app = $("#app");
const stage = $("#stage");
const hint = $("#hint");
const composer = $<HTMLFormElement>("#composer");
const composerInput = $<HTMLInputElement>("#composer-input");
const sizeRange = $<HTMLInputElement>("#size-range");
const gallery = $("#gallery");
const galleryList = $("#gallery-list");
const toastEl = $("#toast");

translateDom();

const settings = { autosave: readPref<boolean>("autosave", false) };

// ------------------------------------------------------------------ state

const state = {
  tool: readPref<Tool>("tool", "pen"),
  shape: readPref<ShapeKind>("shape", "rect"),
  color: readPref<string>("color", INKS[0]),
  fill: readPref<boolean>("fill", false),
  sizes: { pen: 6, shape: 4, eraser: 32, text: 28, ...readPref<Partial<Record<Tool, number>>>("sizes", {}) } as Record<Tool, number>,
  draft: null as [number, number] | null,
  chromeOff: false,
  thumbDirty: false,
  dirty: false, // changed since the sheet was last stored
  detached: false, // sheet was deleted from the list while open: autosave pauses until the next change
};
if (!(state.tool in SIZE_RANGE)) state.tool = "pen";

const board = new Board(stage, $<HTMLCanvasElement>("#ink"), $<HTMLCanvasElement>("#overlay"), newSheet(PAPERS[0]));

const brush = (): Brush => ({
  tool: state.tool,
  shape: state.shape,
  color: state.color,
  size: state.sizes[state.tool],
  fill: state.fill,
});

const input = attachInput(stage, {
  board,
  brush,
  intercept: () => {
    const s = swallow;
    swallow = false;
    return s;
  },
  onTextTap: (at) => openComposer(at),
  onUndo: () => board.undo(),
  onRedo: () => board.redo(),
  onPenDetected: () => {
    writePref("penEver", true);
    toast(t.penDetected, 3600);
    sync();
  },
  onDrawStart: () => {
    if (!hint.hidden) hint.hidden = true;
  },
});

// ------------------------------------------------------------------ saving
//
// The list holds only sheets you saved. "Save" overwrites the stored sheet, "Save as"
// stores a copy. With Autosave on, every change is written into the sheet automatically.
// With it off (default), unsaved work is only kept in a hidden recovery slot so a reload
// or a killed tab doesn't lose it; it never shows up in the list.

let saveTimer = 0;
let thumbTimer = 0;
let saveErrorShown = false;
let changeRev = 0;
let persistAsked = false;

const autosaving = () => settings.autosave && !state.detached;
/** shown to the user as "unsaved changes" */
const isUnsaved = () => state.dirty && !autosaving();

board.onChange = () => {
  changeRev++;
  state.dirty = true;
  state.detached = false;
  state.thumbDirty = true;
  if (!persistAsked) {
    persistAsked = true;
    requestPersistence();
  }
  scheduleSave(settings.autosave ? 600 : 450);
  sync();
};
board.onView = () => {
  syncZoom();
  if (state.dirty || (settings.autosave && board.sheet.savedAt)) scheduleSave(900);
};

function scheduleSave(ms: number) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void writeBack(false), ms);
  // Thumbnail only once drawing pauses, so it never competes with input.
  if (settings.autosave && state.thumbDirty) {
    clearTimeout(thumbTimer);
    thumbTimer = window.setTimeout(() => {
      const run = () => {
        if (!board.drawing && state.thumbDirty) void writeBack(true);
      };
      if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 2000 });
      else run();
    }, 2500);
  }
}

/** Background persistence: autosave into the sheet, or keep the recovery copy. */
async function writeBack(withThumb: boolean) {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const sheet = board.sheet;
  const rev = changeRev;
  try {
    if (autosaving()) {
      if (!sheet.savedAt && sheet.marks.length === 0 && sheet.bg === PAPERS[0]) return; // no blank sheets in the list
      let thumb: Blob | undefined;
      if (withThumb && state.thumbDirty) {
        thumb = await makeThumb(sheet);
        if (rev === changeRev) state.thumbDirty = false;
      }
      sheet.savedAt = Date.now();
      await persist(sheet, { thumb, clearRecovery: true });
      writePref("current", sheet.id);
      if (rev === changeRev) state.dirty = false;
      sync();
    } else if (state.dirty) {
      await putRecovery(sheet);
    }
  } catch {
    failSave();
  }
}

function failSave() {
  if (saveErrorShown) return;
  saveErrorShown = true;
  toast(t.saveFailed, 4000);
}

/** Explicit save: store the sheet in the list. */
async function commit(): Promise<boolean> {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const sheet = board.sheet;
  const rev = changeRev;
  try {
    const thumb = await makeThumb(sheet);
    sheet.savedAt = Date.now();
    await persist(sheet, { thumb, clearRecovery: true });
    if (rev === changeRev) {
      state.dirty = false;
      state.thumbDirty = false;
    }
    state.detached = false;
    writePref("current", sheet.id);
    sync();
    return true;
  } catch {
    toast(t.saveFailed, 4000);
    return false;
  }
}

function defaultName() {
  return new Intl.DateTimeFormat(LANG, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date());
}

async function saveDoc(): Promise<boolean> {
  closePops();
  if (!board.sheet.name) return saveAs(false);
  if (!state.dirty && board.sheet.savedAt) {
    toast(t.upToDate);
    return true;
  }
  const ok = await commit();
  if (ok) toast(t.saved);
  return ok;
}

/** copy=true: store a new sheet; the stored original stays as it was. */
async function saveAs(copy = true): Promise<boolean> {
  closePops();
  const sheet = board.sheet;
  const suggestion = sheet.name ? (copy ? `${sheet.name} ${t.copy}` : sheet.name) : defaultName();
  const name = await ask(t.saveAsTitle, suggestion, t.save);
  if (name === null) return false;
  const label = name || t.untitled;
  if (!copy || !sheet.savedAt) {
    // First save of this sheet: just name and store it.
    sheet.name = name;
    const ok = await commit();
    if (ok) toast(`${t.savedAs} „${label}“`);
    return ok;
  }
  const old = { id: sheet.id, name: sheet.name, created: sheet.created, savedAt: sheet.savedAt };
  sheet.id = newId();
  sheet.name = name;
  sheet.created = Date.now();
  if (!(await commit())) {
    Object.assign(sheet, old);
    return false;
  }
  toast(`${t.savedAs} „${label}“`);
  return true;
}

async function renameCurrent() {
  closePops();
  const sheet = board.sheet;
  const name = await ask(t.renameTitle, sheet.name, t.rename);
  if (name === null) return;
  sheet.name = name;
  if (sheet.savedAt) await renameSheet(sheet.id, name).catch(() => {});
  if (state.dirty) scheduleSave(200);
  sync();
}

async function revertDoc() {
  closePops();
  const snap = await loadSheet(board.sheet.id);
  if (!snap) return;
  if (!(await confirm(t.revertTitle, t.revertBody, t.discard))) return;
  await clearRecovery().catch(() => {});
  await openSheet(snap);
}

/**
 * Before the open sheet is replaced: with unsaved changes, ask Save / Discard / Cancel.
 * Returns false when the user cancels.
 */
async function leaveCurrent(): Promise<boolean> {
  const sheet = board.sheet;
  if (autosaving()) {
    await writeBack(true);
    return true;
  }
  if (!state.dirty || (board.isEmpty && !sheet.savedAt)) {
    await clearRecovery().catch(() => {});
    return true;
  }
  const choice = await choose(t.unsavedTitle, t.unsavedBody.replace("{name}", sheet.name || t.untitled), t.save, t.discard);
  if (choice === "cancel") return false;
  if (choice === "alt") {
    await clearRecovery().catch(() => {});
    return true;
  }
  return sheet.name ? commit() : saveAs(false);
}

function pageRegion(sheet: Sheet): BBox {
  const { w, h } = board.size;
  const b = union(sheet.marks);
  const r: BBox = { x0: 0, y0: 0, x1: w, y1: h };
  if (b) {
    r.x0 = Math.min(r.x0, b.x0 - 16);
    r.y0 = Math.min(r.y0, b.y0 - 16);
    r.x1 = Math.max(r.x1, b.x1 + 16);
    r.y1 = Math.max(r.y1, b.y1 + 16);
  }
  return r;
}

function makeThumb(sheet: Sheet): Promise<Blob | undefined> {
  const r = pageRegion(sheet);
  const scale = 360 / Math.max(r.x1 - r.x0, r.y1 - r.y0);
  const canvas = renderRegion(sheet.marks, sheet.bg, r, scale);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? undefined), "image/webp", 0.82));
}

const flush = () => {
  if (saveTimer || state.dirty) void writeBack(false);
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});
window.addEventListener("pagehide", flush);

/** Replace the open sheet. `dirty`: it carries unsaved changes (restored from recovery). */
async function openSheet(sheet: Sheet, dirty = false) {
  closeComposer();
  sheet.name = sheet.name ?? "";
  board.load(sheet);
  state.dirty = dirty;
  state.detached = false;
  state.thumbDirty = dirty || !sheet.savedAt;
  writePref("current", sheet.id);
  sync();
}

async function createSheet() {
  closePops();
  if (!(await leaveCurrent())) return;
  await openSheet(newSheet(board.sheet.bg));
  closeGallery();
}

// ------------------------------------------------------------------ ui sync

function luminance(hex: string) {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
}

function sync() {
  $<HTMLButtonElement>('[data-act="undo"]').disabled = !board.canUndo;
  $<HTMLButtonElement>('[data-act="redo"]').disabled = !board.canRedo;
  document.querySelectorAll<HTMLElement>("[data-tool]").forEach((el) => {
    el.setAttribute("aria-pressed", String(el.dataset.tool === state.tool));
  });
  $("#shape-icon").setAttribute("href", `#i-${state.shape}`);
  $("#color-dot").style.background = state.color;
  const s = state.sizes[state.tool];
  const [, max] = SIZE_RANGE[state.tool];
  const d = Math.round(4 + (s / max) * 22);
  const dot = $("#size-dot");
  dot.style.width = dot.style.height = `${d}px`;
  stage.classList.toggle("is-text", state.tool === "text");

  const empty = board.isEmpty && !state.draft;
  const textMode = state.tool === "text" && !state.draft;
  hint.hidden = !(empty || textMode);
  if (!hint.hidden) {
    hint.querySelector(".hint-1")!.textContent = textMode ? t.textHint : t.hint;
    (hint.querySelector(".hint-2") as HTMLElement).hidden = textMode;
  }
  hint.classList.toggle("on-dark", luminance(board.sheet.bg) < 140);

  const sh = board.sheet;
  $("#doc-name").textContent = sh.name || t.untitled;
  const docEl = $("#doc");
  docEl.classList.toggle("untitled", !sh.name);
  docEl.classList.toggle("doc-light", luminance(sh.bg) >= 140);
  const unsaved = isUnsaved();
  $("#doc-dot").hidden = !unsaved;
  $("#save-dot").hidden = !unsaved;
  $("#item-revert").hidden = !(sh.savedAt && unsaved);
  syncZoom();
}

function syncZoom() {
  const chip = $('[data-act="fit"]');
  chip.hidden = board.isHomeView;
  $("#zoom-label").textContent = `${Math.round(board.zoom * 100)}%`;
}

function setTool(tool: Tool) {
  if (state.tool === tool) {
    togglePop(tool === "shape" ? "pop-shape" : "pop-size");
    return;
  }
  state.tool = tool;
  writePref("tool", tool);
  if (tool !== "text") closeComposer();
  board.clearPreview();
  closePops();
  sync();
}

// ------------------------------------------------------------------ popovers

let swallow = false;
let openPop: HTMLElement | null = null;

function togglePop(id: string) {
  const el = $(`#${id}`);
  if (openPop === el) return closePops();
  closePops();
  if (id === "pop-color") renderSwatches();
  if (id === "pop-size") renderSize();
  if (id === "pop-shape") renderShape();
  el.hidden = false;
  openPop = el;
}

function closePops() {
  if (openPop) openPop.hidden = true;
  openPop = null;
}

// Tap outside a popover closes it — and a tap on the canvas doesn't also draw.
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!openPop) return;
    const target = e.target as HTMLElement;
    if (openPop.contains(target) || target.closest("[data-act='menu'],[data-act='color'],[data-act='size'],[data-tool]")) return;
    closePops();
    if (stage.contains(target)) swallow = true;
  },
  true,
);

function swatch(color: string, label: string, pressed: boolean, onPick: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "swatch";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.setAttribute("aria-pressed", String(pressed));
  const s = document.createElement("span");
  s.style.background = color;
  b.append(s);
  b.addEventListener("click", onPick);
  return b;
}

function customSwatch(value: string, pressed: boolean, live: boolean, onPick: (v: string) => void) {
  const l = document.createElement("label");
  l.className = "swatch custom";
  l.title = t.custom;
  l.setAttribute("aria-pressed", String(pressed));
  l.innerHTML = `<span><svg><use href="#i-plus"/></svg></span>`;
  const i = document.createElement("input");
  i.type = "color";
  i.value = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  i.setAttribute("aria-label", t.custom);
  i.addEventListener(live ? "input" : "change", () => onPick(i.value.toLowerCase()));
  if (live) i.addEventListener("change", () => onPick(i.value.toLowerCase()));
  l.append(i);
  return l;
}

function renderSwatches() {
  const inks = $("#inks");
  inks.replaceChildren(
    ...INKS.map((c, i) =>
      swatch(c, t.inks[i], c === state.color, () => {
        setColor(c);
        renderSwatches();
      }),
    ),
    customSwatch(state.color, !INKS.includes(state.color), true, (v) => {
      setColor(v);
    }),
  );
  const papers = $("#papers");
  const bg = board.sheet.bg;
  papers.replaceChildren(
    ...PAPERS.map((c, i) =>
      swatch(c, `${t.paper}: ${t.papers[i]}`, c === bg, () => {
        board.setBackground(c);
        renderSwatches();
      }),
    ),
    customSwatch(bg, !PAPERS.includes(bg), false, (v) => {
      board.setBackground(v);
      renderSwatches();
    }),
  );
}

function setColor(c: string) {
  state.color = c;
  writePref("color", c);
  if (state.tool === "eraser") {
    state.tool = "pen";
    writePref("tool", "pen");
  }
  if (state.draft) board.previewText(state.draft, composerInput.value, c, state.sizes.text);
  sync();
}

function renderSize() {
  const tool = state.tool;
  const [min, max, presets] = SIZE_RANGE[tool];
  sizeRange.min = String(min);
  sizeRange.max = String(max);
  sizeRange.value = String(state.sizes[tool]);
  $("#size-title").textContent = tool === "text" ? t.fontSize : t.size;
  const list = $("#size-presets");
  list.replaceChildren(
    ...presets.map((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.setAttribute("aria-label", `${p}`);
      const dot = document.createElement("span");
      const d = Math.round(4 + (p / max) * 20);
      dot.style.width = dot.style.height = `${d}px`;
      b.append(dot);
      b.addEventListener("click", () => setSize(p));
      return b;
    }),
  );
  updateSizePreview();
}

function updateSizePreview() {
  const s = state.sizes[state.tool];
  $("#size-value").textContent = `${s}`;
  const prev = $("#size-preview");
  const d = Math.min(64, s);
  prev.style.width = prev.style.height = `${d}px`;
  prev.style.background = state.tool === "eraser" ? "transparent" : state.color;
  prev.style.boxShadow = state.tool === "eraser" || luminance(state.color) < 40 ? "0 0 0 1.5px var(--muted)" : "";
}

function setSize(v: number) {
  state.sizes[state.tool] = v;
  writePref("sizes", state.sizes);
  sizeRange.value = String(v);
  updateSizePreview();
  if (state.draft) board.previewText(state.draft, composerInput.value, state.color, state.sizes.text);
  sync();
}

sizeRange.addEventListener("input", () => setSize(Number(sizeRange.value)));

function renderShape() {
  document.querySelectorAll<HTMLElement>("[data-shape]").forEach((el) => {
    el.setAttribute("aria-pressed", String(el.dataset.shape === state.shape));
  });
  const fill = $("#fill-toggle");
  fill.setAttribute("aria-pressed", String(state.fill));
  (fill as HTMLButtonElement).disabled = state.shape === "line";
}

document.querySelectorAll<HTMLElement>("[data-shape]").forEach((el) =>
  el.addEventListener("click", () => {
    state.shape = el.dataset.shape as ShapeKind;
    writePref("shape", state.shape);
    renderShape();
    sync();
  }),
);
$("#fill-toggle").addEventListener("click", () => {
  state.fill = !state.fill;
  writePref("fill", state.fill);
  renderShape();
});

// ------------------------------------------------------------------ text

function openComposer(at: [number, number]) {
  state.draft = at;
  composer.hidden = false;
  composerInput.focus({ preventScroll: true });
  board.previewText(at, composerInput.value, state.color, state.sizes.text);
  sync();
}

function closeComposer() {
  if (!state.draft) return;
  state.draft = null;
  composer.hidden = true;
  composerInput.value = "";
  composerInput.blur();
  board.clearPreview();
  sync();
}

composerInput.addEventListener("input", () => {
  if (state.draft) board.previewText(state.draft, composerInput.value, state.color, state.sizes.text);
});
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.draft) board.commitText(state.draft, composerInput.value, state.color, state.sizes.text);
  closeComposer();
});
composerInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeComposer();
});

// Keep the composer above the on-screen keyboard.
const vv = window.visualViewport;
if (vv) {
  const kb = () => {
    const inset = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
    document.documentElement.style.setProperty("--kb", `${inset}px`);
  };
  vv.addEventListener("resize", kb);
  vv.addEventListener("scroll", kb);
  kb();
}

// ------------------------------------------------------------------ gallery

let galleryItems: SheetMeta[] = [];
let galleryView = readPref<"grid" | "list">("galleryView", "grid");
let gallerySort = readPref<"recent" | "name">("gallerySort", "recent");
const thumbUrls = new Map<string, string>();
const searchEl = $<HTMLInputElement>("#search");

function thumbUrl(m: SheetMeta, blob: Blob) {
  const key = `${m.id}@${m.updated}`;
  let url = thumbUrls.get(key);
  if (!url) {
    url = URL.createObjectURL(blob);
    thumbUrls.set(key, url);
  }
  return url;
}

function freeThumbs() {
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls.clear();
}

async function showGallery() {
  closePops();
  closeComposer();
  if (autosaving()) await writeBack(true);
  searchEl.value = "";
  await refreshGallery();
  gallery.hidden = false;
  $<HTMLButtonElement>('[data-act="gallery-close"]').focus({ preventScroll: true });
}

/** Reload the list from storage (no side effects on the open sheet). */
async function refreshGallery() {
  galleryItems = await listSheets().catch(() => []);
  freeThumbs();
  searchEl.parentElement!.hidden = galleryItems.length < 5;
  renderGallery();
}

function renderGallery() {
  const list = galleryList;
  list.classList.toggle("list", galleryView === "list");
  $("#view-icon").setAttribute("href", galleryView === "grid" ? "#i-list" : "#i-grid");
  const viewLabel = galleryView === "grid" ? t.viewList : t.viewGrid;
  $("#view-toggle").setAttribute("aria-label", viewLabel);
  $("#view-toggle").title = viewLabel;
  $("#sort-toggle").textContent = gallerySort === "recent" ? t.sortRecent : t.sortName;

  const q = searchEl.value.trim().toLowerCase();
  const fmt = new Intl.DateTimeFormat(LANG, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let items = galleryItems.filter((m) => !q || (m.name || t.untitled).toLowerCase().includes(q));
  if (gallerySort === "name") {
    items = [...items].sort((a, b) => (a.name || "\uffff").localeCompare(b.name || "\uffff", LANG, { numeric: true, sensitivity: "base" }) || b.updated - a.updated);
  }
  const empty = $("#gallery-empty");
  empty.hidden = items.length > 0;
  empty.textContent = galleryItems.length ? t.noResults : t.noSheets;

  list.replaceChildren(
    ...items.map((m) => {
      const isCurrent = m.id === board.sheet.id;
      const li = document.createElement("li");
      li.className = "card";
      if (isCurrent) li.setAttribute("aria-current", "true");

      const open = document.createElement("button");
      open.className = "card-open";
      open.type = "button";
      open.style.background = m.bg;
      open.setAttribute("aria-label", `${t.open}: ${m.name || t.untitled}`);
      const showThumb = (blob: Blob) => {
        const img = document.createElement("img");
        img.src = thumbUrl(m, blob);
        img.alt = "";
        img.decoding = "async";
        img.loading = "lazy";
        open.append(img);
      };
      if (m.thumb) showThumb(m.thumb);
      else if (m.n > 0) {
        // Missing preview (e.g. autosave wrote the sheet before its preview was ready): build it once.
        void loadSheet(m.id).then(async (sheet) => {
          if (!sheet) return;
          const blob = await makeThumb(sheet);
          if (!blob) return;
          showThumb(blob);
          await persist(sheet, { thumb: blob }).catch(() => {});
        });
      }
      open.addEventListener("click", async () => {
        if (!isCurrent) {
          if (!(await leaveCurrent())) return;
          const sheet = await loadSheet(m.id);
          if (sheet) await openSheet(sheet);
        }
        closeGallery();
      });

      const meta = document.createElement("div");
      meta.className = "card-meta";
      const text = document.createElement("div");
      text.className = "card-text";
      const name = document.createElement("span");
      name.className = "card-name" + (m.name ? "" : " untitled");
      name.textContent = m.name || t.untitled;
      const date = document.createElement("span");
      date.className = "card-date";
      if (isCurrent && isUnsaved()) {
        const b = document.createElement("span");
        b.className = "tag";
        b.textContent = t.changed;
        date.append(b);
      }
      date.append(fmt.format(m.updated));
      text.append(name, date);

      const actions = document.createElement("div");
      actions.className = "card-actions";
      const ren = iconButton("#i-rename", t.rename, async () => {
        const next = await ask(t.renameTitle, m.name, t.rename);
        if (next === null) return;
        if (isCurrent) {
          board.sheet.name = next;
          if (state.dirty) scheduleSave(200);
          sync();
        }
        await renameSheet(m.id, next).catch(() => {});
        await refreshGallery();
      });
      const del = iconButton("#i-trash", t.delete, async () => {
        if (!(await confirm(t.deleteTitle, isCurrent ? t.deleteCurrentBody : t.deleteBody, t.delete))) return;
        await deleteSheet(m.id);
        if (isCurrent) {
          // Only the saved copy is removed; the drawing on screen carries on as an unsaved sheet.
          const sheet = board.sheet;
          sheet.savedAt = undefined;
          sheet.name = "";
          state.detached = true;
          state.dirty = !board.isEmpty;
          state.thumbDirty = true;
          if (state.dirty) await putRecovery(sheet).catch(() => {});
          sync();
        }
        await refreshGallery();
      });
      actions.append(ren, del);
      meta.append(text, actions);
      li.append(open, meta);
      return li;
    }),
  );
}

function iconButton(icon: string, label: string, onClick: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = `<svg><use href="${icon}"/></svg>`;
  b.addEventListener("click", onClick);
  return b;
}

searchEl.addEventListener("input", renderGallery);

function closeGallery() {
  gallery.hidden = true;
  freeThumbs();
}

// ------------------------------------------------------------------ confirm & toast

function confirm(title: string, body: string, ok: string): Promise<boolean> {
  const modal = $("#confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  const yes = $<HTMLButtonElement>("#confirm-yes");
  const no = $<HTMLButtonElement>("#confirm-no");
  yes.textContent = ok;
  yes.className = "cta danger";
  modal.hidden = false;
  no.focus();
  return new Promise((resolve) => {
    const finish = (v: boolean) => {
      modal.hidden = true;
      yes.onclick = no.onclick = modal.onclick = null;
      document.removeEventListener("keydown", esc, true);
      resolve(v);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(false);
      }
    };
    document.addEventListener("keydown", esc, true);
    yes.onclick = () => finish(true);
    no.onclick = () => finish(false);
    modal.onclick = (e) => {
      if (e.target === modal) finish(false);
    };
  });
}

/** Three-way dialog: primary ("yes"), secondary ("alt", e.g. Discard) or Cancel. */
function choose(title: string, body: string, yesLabel: string, altLabel: string): Promise<"yes" | "alt" | "cancel"> {
  const modal = $("#confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  const yes = $<HTMLButtonElement>("#confirm-yes");
  const alt = $<HTMLButtonElement>("#confirm-alt");
  const no = $<HTMLButtonElement>("#confirm-no");
  yes.textContent = yesLabel;
  yes.className = "cta";
  alt.textContent = altLabel;
  alt.hidden = false;
  modal.hidden = false;
  yes.focus();
  return new Promise((resolve) => {
    const finish = (v: "yes" | "alt" | "cancel") => {
      modal.hidden = true;
      alt.hidden = true;
      yes.onclick = alt.onclick = no.onclick = modal.onclick = null;
      document.removeEventListener("keydown", esc, true);
      resolve(v);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish("cancel");
      }
    };
    document.addEventListener("keydown", esc, true);
    yes.onclick = () => finish("yes");
    alt.onclick = () => finish("alt");
    no.onclick = () => finish("cancel");
    modal.onclick = (e) => {
      if (e.target === modal) finish("cancel");
    };
  });
}

function ask(title: string, value: string, ok: string): Promise<string | null> {
  const form = $<HTMLFormElement>("#prompt");
  const input = $<HTMLInputElement>("#prompt-input");
  const no = $<HTMLButtonElement>("#prompt-no");
  $("#prompt-title").textContent = title;
  $("#prompt-yes").textContent = ok;
  input.value = value;
  form.hidden = false;
  input.focus();
  input.select();
  return new Promise((resolve) => {
    const finish = (v: string | null) => {
      form.hidden = true;
      form.onsubmit = no.onclick = form.onclick = null;
      input.onkeydown = null;
      resolve(v);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      finish(input.value.trim().slice(0, 60));
    };
    no.onclick = () => finish(null);
    form.onclick = (e) => {
      if (e.target === form) finish(null);
    };
    input.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(null);
      }
    };
  });
}

let toastTimer = 0;
function toast(text: string, ms = 2400, action?: { label: string; run: () => void }) {
  $("#toast-text").textContent = text;
  const btn = $<HTMLButtonElement>("#toast-action");
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => {
      toastEl.hidden = true;
      action.run();
    };
  }
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms);
}

// ------------------------------------------------------------------ export

async function renderExport(): Promise<{ blob: Blob; name: string } | null> {
  const sheet = board.sheet;
  const content = union(sheet.marks);
  const { w, h } = board.size;
  const r: BBox = content
    ? { x0: content.x0 - 32, y0: content.y0 - 32, x1: content.x1 + 32, y1: content.y1 + 32 }
    : { x0: 0, y0: 0, x1: w, y1: h };
  const rw = r.x1 - r.x0;
  const rh = r.y1 - r.y0;
  // 2× for crisp prints, capped so huge drawings stay within mobile canvas limits.
  const scale = Math.min(2, 8192 / Math.max(rw, rh), Math.sqrt(16_000_000 / (rw * rh)));
  const canvas = renderRegion(sheet.marks, sheet.bg, r, scale);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) return null;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const base = (sheet.name || "jotter").replace(/[\\/:*?"<>|]+/g, "-").trim() || "jotter";
  return { blob, name: `${base}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.png` };
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Share sheet where the device has one; plain download otherwise. */
async function shareImage() {
  closePops();
  const out = await renderExport();
  if (!out) return;
  const file = new File([out.blob], out.name, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Jotter" });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }
  saveBlob(out.blob, out.name);
  toast(t.imageSaved);
}

/** Always a file download (Settings). */
async function downloadImage() {
  const out = await renderExport();
  if (!out) return;
  saveBlob(out.blob, out.name);
  toast(t.imageSaved);
}

// ------------------------------------------------------------------ fullscreen, chrome, install

const canFull = !!document.fullscreenEnabled;
$("#item-full").hidden = !canFull;
document.addEventListener("fullscreenchange", () => {
  $("#full-label").textContent = document.fullscreenElement ? t.exitFullscreen : t.fullscreen;
});

function setChrome(off: boolean) {
  state.chromeOff = off;
  app.classList.toggle("chrome-off", off);
  $("#restore").hidden = !off;
  closePops();
}

let installEvent: (Event & { prompt(): Promise<void> }) | null = null;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
$("#set-install").hidden = !(isIOS && !standalone);
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e as typeof installEvent;
  $("#set-install").hidden = false;
});
window.addEventListener("appinstalled", () => ($("#set-install").hidden = true));

// ------------------------------------------------------------------ settings

const settingsEl = $("#settings");
const setAutosave = $<HTMLButtonElement>("#set-autosave");
const setFingers = $<HTMLButtonElement>("#set-fingers");
const setLang = $<HTMLSelectElement>("#set-lang");

function renderSettings() {
  setAutosave.setAttribute("aria-checked", String(settings.autosave));
  setLang.value = readPref<string>("lang", "auto");
  setFingers.hidden = !(input.penSeen || readPref<boolean>("penEver", false));
  setFingers.setAttribute("aria-checked", String(!input.penSeen));
}

function openSettings() {
  closePops();
  renderSettings();
  settingsEl.hidden = false;
  setAutosave.focus({ preventScroll: true });
}

function closeSettings() {
  settingsEl.hidden = true;
}

settingsEl.addEventListener("click", (e) => {
  if (e.target === settingsEl) closeSettings();
});

setAutosave.addEventListener("click", async () => {
  settings.autosave = !settings.autosave;
  writePref("autosave", settings.autosave);
  renderSettings();
  // Turning it on stores what is open right now.
  if (settings.autosave && state.dirty) await writeBack(true);
  sync();
});

setFingers.addEventListener("click", () => {
  input.setPenSeen(!input.penSeen); // on = fingers draw, so palm rejection flips
  renderSettings();
});

setLang.addEventListener("change", () => {
  writePref("lang", setLang.value);
  flush();
  window.setTimeout(() => location.reload(), 150);
});

// ------------------------------------------------------------------ actions

const actions: Record<string, () => void> = {
  undo: () => board.undo(),
  redo: () => board.redo(),
  gallery: () => void showGallery(),
  "gallery-close": closeGallery,
  new: () => void createSheet(),
  save: () => void saveDoc(),
  "save-as": () => void saveAs(true),
  rename: () => void renameCurrent(),
  revert: () => void revertDoc(),
  view: () => {
    galleryView = galleryView === "grid" ? "list" : "grid";
    writePref("galleryView", galleryView);
    renderGallery();
  },
  sort: () => {
    gallerySort = gallerySort === "recent" ? "name" : "recent";
    writePref("gallerySort", gallerySort);
    renderGallery();
  },
  share: () => void shareImage(),
  menu: () => togglePop("pop-menu"),
  color: () => togglePop("pop-color"),
  size: () => togglePop("pop-size"),
  fit: () => {
    board.fitView();
  },
  clear: async () => {
    closePops();
    if (board.isEmpty) return;
    if (await confirm(t.clearTitle, t.clearBody, t.confirmClear)) board.clear();
  },
  fullscreen: async () => {
    closePops();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch {
      /* refused (iframe, iOS) */
    }
  },
  chrome: () => setChrome(!state.chromeOff),
  settings: openSettings,
  "settings-close": closeSettings,
  download: () => void downloadImage(),
  install: async () => {
    closePops();
    if (installEvent) {
      await installEvent.prompt();
      installEvent = null;
      $("#set-install").hidden = true;
    } else toast(t.iosInstall, 6000);
  },
  "cancel-text": closeComposer,
};

app.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act],[data-tool]");
  if (!el || (el as HTMLButtonElement).disabled) return;
  if (el.dataset.tool) setTool(el.dataset.tool as Tool);
  else if (el.dataset.act && actions[el.dataset.act]) {
    if (!["menu", "color", "size"].includes(el.dataset.act)) closePops();
    actions[el.dataset.act]();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!settingsEl.hidden) return closeSettings();
    if (openPop) return closePops();
    if (!gallery.hidden) return closeGallery();
    if (state.chromeOff) return setChrome(false);
    return;
  }
  if (isTyping(e.target)) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") {
    e.preventDefault();
    if (e.shiftKey) board.redo();
    else board.undo();
  } else if (mod && k === "y") {
    e.preventDefault();
    board.redo();
  } else if (mod && k === "s") {
    e.preventDefault();
    if (e.shiftKey) void saveAs(true);
    else void saveDoc();
  } else if (mod && k === "o") {
    e.preventDefault();
    void showGallery();
  } else if (mod || e.altKey) {
    return;
  } else if (k === "p" || k === "b") setTool("pen");
  else if (k === "s") setTool("shape");
  else if (k === "e") setTool("eraser");
  else if (k === "t") {
    e.preventDefault();
    setTool("text");
  } else if (k === "[" || k === "]") {
    const [min, max] = SIZE_RANGE[state.tool];
    const cur = state.sizes[state.tool];
    const step = Math.max(1, Math.round(cur * 0.15));
    setSize(Math.min(max, Math.max(min, cur + (k === "]" ? step : -step))));
  } else if (k === "0") board.fitView();
});

// ------------------------------------------------------------------ boot

async function boot() {
  // Unsaved work from before a reload / killed tab comes back first.
  const rec = await loadRecovery().catch(() => undefined);
  if (rec) {
    await openSheet(rec, true);
    if (settings.autosave) scheduleSave(300);
    return;
  }
  const id = readPref<string | null>("current", null);
  const sheet = id ? await loadSheet(id).catch(() => undefined) : undefined;
  if (sheet) await openSheet(sheet);
  else sync();
}

void boot();
sync();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        const offerUpdate = (w: ServiceWorker) =>
          toast(t.updateReady, 0, {
            label: t.reload,
            run: () => w.postMessage("skip-waiting"),
          });
        if (reg.waiting && hadController) offerUpdate(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const w = reg.installing;
          w?.addEventListener("statechange", () => {
            if (w.state !== "installed") return;
            if (navigator.serviceWorker.controller) offerUpdate(w);
            else toast(t.offlineReady);
          });
        });
      })
      .catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloading) return;
      reloading = true;
      flush();
      location.reload();
    });
  });
}
