import "./styles.css";
import { Board } from "./board";
import { t, translateDom, LANG } from "./i18n";
import { attachInput, isTyping, type Brush } from "./input";
import { NOTE_COLORS, draftBox, noteBBox, renderRegion, resizeText, retext, union } from "./render";
import { clearRecovery, deleteSheet, listSheets, loadRecovery, loadSheet, newId, newSheet, persist, putRecovery, readPref, renameSheet, requestPersistence, writePref } from "./store";
import { OPEN_SHAPES, type BBox, type ShapeKind, type Sheet, type SheetMeta, type Selection, type TextDraft, type Tool } from "./types";

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

const settings = { autosave: readPref<boolean>("autosave", false), fullscreen: readPref<boolean>("fullscreen", true) };

// ------------------------------------------------------------------ state

const state = {
  tool: readPref<Tool>("tool", "pen"),
  shape: readPref<ShapeKind>("shape", "rect"),
  color: readPref<string>("color", INKS[0]),
  fill: readPref<boolean>("fill", false),
  sizes: { pen: 6, shape: 4, eraser: 32, text: 28, ...readPref<Partial<Record<Tool, number>>>("sizes", {}) } as Record<Tool, number>,
  draft: null as TextDraft | null,
  sel: null as Selection | null,
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
  edit: {
    active: () => editing(),
    down: (sx, sy, type) => editDown(sx, sy, type),
    move: (sx, sy) => editMove(sx, sy),
    up: () => editUp(),
    canHold: (sx, sy) => board.hitMark(sx, sy) >= 0,
    pickAt: (sx, sy) => {
      const i = board.hitMark(sx, sy);
      if (i >= 0) pickUp(i, sx, sy);
    },
  },
  onUndo: () => undo(),
  onRedo: () => redo(),
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
    if (ok) toast(t.savedAs.replace("{name}", label));
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
  toast(t.savedAs.replace("{name}", label));
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

  const empty = board.isEmpty && !editing();
  const textMode = state.tool === "text";
  // only on an empty sheet: over a drawing it would cover the picture
  hint.hidden = !empty;
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

/** A picked-up text is put back before history moves, so indices stay valid. */
function undo() {
  if (board.isEditing) closeComposer();
  board.undo();
}
function redo() {
  if (board.isEditing) closeComposer();
  board.redo();
}

function setTool(tool: Tool) {
  if (state.tool === tool) {
    togglePop(tool === "shape" ? "pop-shape" : "pop-size");
    return;
  }
  state.tool = tool;
  writePref("tool", tool);
  // switching tools finishes what is being edited
  if (state.sel || (state.draft && tool !== "text")) closeComposer("commit");
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
  if (state.draft) previewDraft({ ...state.draft, c });
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
  if (state.draft && state.tool === "text") previewDraft(resizeText(state.draft, v / board.zoom));
  sync();
}

sizeRange.addEventListener("input", () => setSize(Number(sizeRange.value)));

function renderShape() {
  document.querySelectorAll<HTMLElement>("[data-shape]").forEach((el) => {
    el.setAttribute("aria-pressed", String(el.dataset.shape === state.shape));
  });
  const fill = $("#fill-toggle");
  fill.setAttribute("aria-pressed", String(state.fill));
  (fill as HTMLButtonElement).disabled = OPEN_SHAPES.includes(state.shape);
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

const composerDel = $<HTMLButtonElement>("#composer-del");
const composerCta = $<HTMLButtonElement>("#composer .cta");
const composerInks = $("#composer-inks");
const composerSize = $<HTMLInputElement>("#composer-size");
const textHint = $("#text-hint");
const composerAlphaRow = $("#composer-alpha-row");
const composerAlpha = $<HTMLInputElement>("#composer-alpha");
const composerNote = $<HTMLButtonElement>("#composer-note");
const HOLD_MS = 380;
const MOVE_SLOP = 6;

// One bar (the "composer") edits whatever is active: a text being placed, a picked-up text
// (state.draft), or a picked-up stroke / shape (state.sel).

function previewDraft(d: TextDraft) {
  state.draft = d;
  board.previewText(d);
}

function previewSel(s: Selection) {
  state.sel = s;
  board.previewSelection(s);
}

const editing = () => !!state.draft || !!state.sel;

/** Colour swatches and size slider: text size in px, or scale in % for strokes and shapes. */
function renderComposerTools() {
  const sel = state.sel;
  const d = state.draft;
  if (!sel && !d) return;
  const color = (sel ? sel.c : d!.c).toLowerCase();
  const isNote = sel?.o !== undefined;
  const palette = isNote ? NOTE_COLORS : INKS;
  composerInks.replaceChildren(
    ...palette.map((c, i) => swatch(c, isNote ? c : t.inks[i], c === color, () => setEditColor(c))),
    customSwatch(color, !palette.includes(color), true, (v) => setEditColor(v)),
  );
  composerAlphaRow.hidden = !isNote;
  composerNote.hidden = !isNote;
  if (isNote) {
    composerAlpha.value = String(Math.round(sel!.o! * 100));
    $("#composer-alpha-val").textContent = `${composerAlpha.value}%`;
  }
  if (sel) {
    composerSize.min = "20";
    composerSize.max = "400";
    composerSize.step = "5";
    composerSize.value = String(Math.round(sel.k * 100));
    $("#composer-size-val").textContent = `${composerSize.value}%`;
  } else {
    const [min, max] = SIZE_RANGE.text;
    composerSize.min = String(min);
    composerSize.max = String(max);
    composerSize.step = "1";
    const px = Math.round(d!.s * board.zoom);
    composerSize.value = String(px);
    $("#composer-size-val").textContent = String(px);
  }
}

function setEditColor(c: string) {
  if (state.sel) previewSel({ ...state.sel, c });
  else if (state.draft) {
    previewDraft({ ...state.draft, c });
    // A new text also sets the pen colour; a picked-up one only changes itself.
    if (!board.isEditingText) {
      state.color = c;
      writePref("color", c);
      sync();
    }
  }
  renderComposerTools();
}

composerSize.addEventListener("input", () => {
  const v = Number(composerSize.value);
  if (state.sel) {
    previewSel({ ...state.sel, k: v / 100 });
    $("#composer-size-val").textContent = `${v}%`;
    return;
  }
  if (!state.draft) return;
  previewDraft(resizeText(state.draft, v / board.zoom));
  $("#composer-size-val").textContent = String(v);
  if (!board.isEditingText) {
    state.sizes.text = v;
    writePref("sizes", state.sizes);
  }
});

composerAlpha.addEventListener("input", () => {
  if (!state.sel) return;
  const v = Number(composerAlpha.value);
  previewSel({ ...state.sel, o: v / 100 });
  $("#composer-alpha-val").textContent = `${v}%`;
});

// ---- note cards

const noteEditor = $<HTMLFormElement>("#note-editor");
const noteTitle = $<HTMLInputElement>("#note-title");
const noteBody = $<HTMLTextAreaElement>("#note-body");

/** Title + text dialog; resolves null on cancel. */
function editNote(title: string, body: string): Promise<{ title: string; t: string } | null> {
  noteTitle.value = title;
  noteBody.value = body;
  noteEditor.hidden = false;
  noteTitle.focus();
  return new Promise((resolve) => {
    const finish = (v: { title: string; t: string } | null) => {
      noteEditor.hidden = true;
      noteEditor.onsubmit = null;
      $("#note-no").onclick = null;
      noteEditor.onclick = null;
      document.removeEventListener("keydown", esc, true);
      resolve(v);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(null);
      }
    };
    document.addEventListener("keydown", esc, true);
    noteEditor.onsubmit = (e) => {
      e.preventDefault();
      finish({ title: noteTitle.value.trim(), t: noteBody.value.replace(/\s+$/, "") });
    };
    $("#note-no").onclick = () => finish(null);
    noteEditor.onclick = (e) => {
      if (e.target === noteEditor) finish(null);
    };
  });
}

/** "+ Note" in the shapes menu: write it, it lands in the middle of the view, ready to move. */
async function addNote() {
  closePops();
  if (editing()) closeComposer("commit");
  const res = await editNote("", "");
  if (!res || (!res.title && !res.t)) return;
  const z = board.zoom;
  const w = Math.min(260, board.size.w - 60) / z;
  const h = (res.t ? 200 : 96) / z;
  const [cx, cy] = board.toWorld(board.size.w / 2, board.size.h / 2);
  const x = cx - w / 2;
  const y = cy - h / 2;
  const i = board.add({ k: "note", c: NOTE_COLORS[0], x, y, w, h, s: 17 / z, title: res.title, t: res.t, b: noteBBox(x, y, w, h) });
  const sel = board.beginSelect(i);
  if (!sel) return;
  previewSel(sel);
  showBar("mark");
  sync();
}

async function editNoteText() {
  const sel = state.sel;
  if (!sel || sel.o === undefined) return;
  const res = await editNote(sel.title ?? "", sel.t ?? "");
  if (res && state.sel === sel) previewSel({ ...sel, ...res });
}

function showBar(mode: "text-new" | "text-edit" | "mark") {
  composer.hidden = false;
  composerInput.hidden = mode === "mark";
  composerCta.textContent = mode === "mark" ? t.done : t.place;
  composerDel.hidden = mode === "text-new";
  app.classList.add("editing");
  renderComposerTools();
}

/**
 * Open the bar for a new text whose top-left corner sits at world point `at`.
 * The on-screen keyboard only comes up when the text field itself is tapped (or with a mouse).
 */
function openComposer(at: [number, number], focus = false) {
  previewDraft({ x: at[0], y: at[1], r: 0, t: "", c: state.color, s: state.sizes.text / board.zoom });
  composerInput.value = "";
  showBar("text-new");
  if (focus) composerInput.focus({ preventScroll: true });
  sync();
}

/** Close the bar: drop the changes, or `commit` them, or `remove` the picked-up item. */
function closeComposer(how?: "commit" | "remove") {
  clearTimeout(drag?.kind === "hold" ? drag.timer : 0);
  drag = null;
  hideTextHint();
  composer.classList.remove("away");
  if (!editing()) return;
  const sel = state.sel;
  const d = state.draft;
  state.sel = null;
  state.draft = null;
  if (sel) {
    if (how) board.commitSelection(sel, how === "remove");
    else board.cancelEdit();
  } else if (d) {
    if (how === "commit") board.commitText(d);
    else if (how === "remove" && board.isEditingText) board.commitText({ ...d, t: "" });
    else board.cancelEdit();
  }
  composer.hidden = true;
  app.classList.remove("editing");
  composerInput.value = "";
  composerInput.blur();
  board.clearPreview();
  sync();
}

composerInput.addEventListener("input", () => {
  if (state.draft) previewDraft(retext(state.draft, composerInput.value));
});
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  closeComposer("commit");
});
composerInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeComposer();
});
composerDel.addEventListener("click", () => closeComposer("remove"));

// ---- moving, rotating, picking up

type Drag =
  | { kind: "move"; ox: number; oy: number; moved: boolean; sx: number; sy: number }
  | { kind: "rotate" }
  | { kind: "hold"; index: number; sx: number; sy: number; timer: number }
  | { kind: "none" };
let drag: Drag | null = null;

function showTextHint(index: number) {
  const r = board.textScreenRect(index);
  if (!r) return;
  const box = stage.getBoundingClientRect();
  textHint.hidden = false;
  textHint.style.animation = "none";
  void textHint.offsetWidth;
  textHint.style.animation = "";
  const w = textHint.offsetWidth;
  const left = Math.min(box.right - w - 8, Math.max(box.left + 8, box.left + r.x + r.w / 2 - w / 2));
  const above = box.top + r.y - 46;
  textHint.style.left = `${left}px`;
  textHint.style.top = `${above > box.top + 70 ? above : box.top + r.y + r.h + 12}px`;
}

function hideTextHint() {
  textHint.hidden = true;
}

/** Dragging starts: the bar and the keyboard get out of the way. */
function stepAside() {
  composer.classList.add("away");
  composerInput.blur();
}

/** Pointer down while editing, or in the text tool. Returns true: the editor owns this pointer. */
function editDown(sx: number, sy: number, pointerType: string): boolean {
  hideTextHint();
  const w = board.toWorld(sx, sy);
  if (state.sel) {
    const sel = state.sel;
    const hit = board.hitSelection(sel, sx, sy);
    if (hit === "rotate") {
      drag = { kind: "rotate" };
      stepAside();
    } else if (hit === "body") {
      drag = { kind: "move", ox: w[0] - sel.dx, oy: w[1] - sel.dy, moved: false, sx, sy };
    } else {
      // tapping elsewhere finishes the edit
      closeComposer("commit");
      drag = { kind: "none" };
    }
    return true;
  }
  if (state.draft) {
    const d = state.draft;
    const hit = board.hitDraft(d, sx, sy);
    if (hit === "rotate") {
      drag = { kind: "rotate" };
      stepAside();
      return true;
    }
    if (hit === "body") {
      drag = { kind: "move", ox: w[0] - d.x, oy: w[1] - d.y, moved: false, sx, sy };
      return true;
    }
    // Anywhere else: the field jumps there (its top-left corner under the finger) and can be dragged on.
    const { w: bw, h: bh } = draftBox(d);
    const cos = Math.cos(d.r);
    const sin = Math.sin(d.r);
    const cx = w[0] + (bw / 2) * cos - (bh / 2) * sin;
    const cy = w[1] + (bw / 2) * sin + (bh / 2) * cos;
    const moved = { ...d, x: cx - bw / 2, y: cy - bh / 2 };
    previewDraft(moved);
    drag = { kind: "move", ox: w[0] - moved.x, oy: w[1] - moved.y, moved: false, sx, sy };
    return true;
  }
  const i = board.hitMark(sx, sy);
  if (i >= 0 && board.isText(i)) {
    // A placed text: a tap only hints, holding picks it up.
    showTextHint(i);
    drag = { kind: "hold", index: i, sx, sy, timer: window.setTimeout(() => holdDone(i), HOLD_MS) };
    return true;
  }
  openComposer(w, pointerType === "mouse");
  drag = { kind: "move", ox: 0, oy: 0, moved: false, sx, sy };
  return true;
}

function holdDone(index: number) {
  if (drag?.kind !== "hold") return;
  pickUp(index, drag.sx, drag.sy);
}

/** Pick up mark `index` under the finger at (sx, sy); it follows the finger right away. */
function pickUp(index: number, sx: number, sy: number) {
  const w = board.toWorld(sx, sy);
  hideTextHint();
  if (board.isText(index)) {
    const d = board.beginEdit(index);
    if (!d) return;
    previewDraft(d);
    composerInput.value = d.t;
    showBar("text-edit");
    drag = { kind: "move", ox: w[0] - d.x, oy: w[1] - d.y, moved: true, sx, sy };
  } else {
    const sel = board.beginSelect(index);
    if (!sel) return;
    previewSel(sel);
    showBar("mark");
    drag = { kind: "move", ox: w[0], oy: w[1], moved: true, sx, sy };
  }
  navigator.vibrate?.(18);
  stepAside();
  sync();
}

function editMove(sx: number, sy: number) {
  const d = drag;
  if (!d) return;
  if (d.kind === "hold") {
    if (Math.hypot(sx - d.sx, sy - d.sy) > 10) {
      clearTimeout(d.timer);
      hideTextHint();
      drag = { kind: "none" };
    }
  } else if (d.kind === "rotate") {
    if (state.sel) previewSel({ ...state.sel, r: board.selAngle(state.sel, sx, sy) });
    else if (state.draft) previewDraft({ ...state.draft, r: board.angleTo(state.draft, sx, sy) });
  } else if (d.kind === "move") {
    if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < MOVE_SLOP) return;
    if (!d.moved) {
      d.moved = true;
      stepAside();
    }
    const w = board.toWorld(sx, sy);
    if (state.sel) previewSel({ ...state.sel, dx: w[0] - d.ox, dy: w[1] - d.oy });
    else if (state.draft) previewDraft({ ...state.draft, x: w[0] - d.ox, y: w[1] - d.oy });
  }
}

function editUp() {
  const d = drag;
  drag = null;
  if (d?.kind === "hold") {
    clearTimeout(d.timer); // a plain tap: the hint stays for a moment
    window.setTimeout(hideTextHint, 1500);
  }
  composer.classList.remove("away");
}

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
  // compact: time for today, date otherwise (cards are narrow on phones)
  const timeFmt = new Intl.DateTimeFormat(LANG, { hour: "numeric", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat(LANG, { day: "numeric", month: "short" });
  const yearFmt = new Intl.DateTimeFormat(LANG, { day: "numeric", month: "short", year: "numeric" });
  const today = new Date().toDateString();
  const thisYear = new Date().getFullYear();
  const fmt = {
    format: (ms: number) => {
      const d = new Date(ms);
      if (d.toDateString() === today) return timeFmt.format(d);
      return d.getFullYear() === thisYear ? dayFmt.format(d) : yearFmt.format(d);
    },
  };
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

const canFull = !!document.fullscreenEnabled && !!document.documentElement.requestFullscreen;

function enterFullscreen() {
  if (!canFull || document.fullscreenElement) return;
  document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {
    /* refused (iframe, iOS Safari) */
  });
}

// Browsers only allow full screen after a tap/key press, so it starts with the first one.
// Leaving it again (Esc, back gesture) is respected until the next launch.
if (canFull && settings.fullscreen) {
  const go = () => {
    window.removeEventListener("pointerup", go, true);
    window.removeEventListener("keydown", go, true);
    if (settings.fullscreen) enterFullscreen();
  };
  window.addEventListener("pointerup", go, true);
  window.addEventListener("keydown", go, true);
}

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
const setFull = $<HTMLButtonElement>("#set-full");

function renderSettings() {
  setAutosave.setAttribute("aria-checked", String(settings.autosave));
  setLang.value = readPref<string>("lang", "auto");
  setFull.hidden = !canFull;
  setFull.setAttribute("aria-checked", String(settings.fullscreen));
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

setFull.addEventListener("click", () => {
  settings.fullscreen = !settings.fullscreen;
  writePref("fullscreen", settings.fullscreen);
  renderSettings();
  if (settings.fullscreen) enterFullscreen();
  else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
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
  undo: () => undo(),
  redo: () => redo(),
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
    if (await confirm(t.clearTitle, t.clearBody, t.confirmClear)) {
      closeComposer();
      board.clear();
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
  "cancel-text": () => closeComposer(),
  "add-note": () => void addNote(),
  "note-text": () => void editNoteText(),
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
  if (editing() && !isTyping(e.target)) {
    if (e.key === "Escape") return closeComposer();
    if (e.key === "Enter") return closeComposer("commit");
    if (state.sel && (e.key === "Delete" || e.key === "Backspace")) return closeComposer("remove");
    // typing with a hardware keyboard goes straight into the text field
    if (state.draft && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      composerInput.focus({ preventScroll: true });
      return;
    }
  }
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
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && k === "y") {
    e.preventDefault();
    redo();
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
