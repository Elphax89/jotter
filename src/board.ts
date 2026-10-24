import {
  drawMarks,
  drawSegment,
  drawShape,
  drawTail,
  draftBox,
  drawText,
  emptyBox,
  grow,
  retext,
  setStrokeStyle,
  shapeBox,
  textBBox,
  union,
} from "./render";
import { OPEN_SHAPES, type BBox, type Mark, type ShapeKind, type Sheet, type TextDraft, type View } from "./types";

type Op =
  | { t: "add"; m: Mark }
  | { t: "edit"; i: number; from: Mark; to: Mark }
  | { t: "del"; i: number; m: Mark }
  | { t: "clear"; marks: Mark[] }
  | { t: "bg"; from: string; to: string };

interface LiveStroke {
  color: string;
  width: number;
  erase: boolean;
  pressure: boolean;
  pts: number[];
  ws: number[];
  box: BBox;
  /** smoothed pressure */
  sp: number;
}

const HISTORY_LIMIT = 300;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 8;
/** Above this full-render time, gestures use a cheap CSS transform and re-render when idle. */
const FAST_RENDER_MS = 7;

/**
 * Owns the two canvases (ink + overlay), the sheet data, history and view.
 * Ink canvas: committed marks, drawn incrementally while you draw — no
 * full repaint per pointer move. Overlay canvas: shape/text previews only.
 * Paper colour is plain CSS behind the ink, so the eraser simply reveals it.
 */
export class Board {
  readonly stage: HTMLElement;
  private ink: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private ictx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;

  sheet: Sheet;
  private past: Op[] = [];
  private future: Op[] = [];
  private live: LiveStroke | null = null;

  /** current view */
  view: View = { x: 0, y: 0, z: 1 };
  /** view the ink canvas was last fully rendered with */
  private drawnView: View = { x: 0, y: 0, z: 1 };
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private raf = 0;
  private idleTimer = 0;
  private lastRenderMs = 0;

  /** called after every committed change (save, UI refresh) */
  onChange: () => void = () => {};
  /** called when only the view changed */
  onView: () => void = () => {};

  constructor(stage: HTMLElement, ink: HTMLCanvasElement, overlay: HTMLCanvasElement, sheet: Sheet) {
    this.stage = stage;
    this.ink = ink;
    this.overlay = overlay;
    // Plain 2D context: the ink layer must stay transparent over the CSS paper colour on every GPU.
    this.ictx = ink.getContext("2d") as CanvasRenderingContext2D;
    this.octx = overlay.getContext("2d") as CanvasRenderingContext2D;
    this.sheet = sheet;
    this.view = { ...sheet.view };
    this.applyBackground();
    new ResizeObserver(() => this.resize()).observe(stage);
    this.resize();
  }

  // ---------------------------------------------------------------- sheet

  load(sheet: Sheet) {
    this.cancelStroke();
    this.editing = null;
    this.sheet = sheet;
    this.past = [];
    this.future = [];
    this.view = { ...sheet.view };
    this.applyBackground();
    this.fullRender();
    this.onView();
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  get isEmpty() {
    return this.sheet.marks.length === 0;
  }

  private push(op: Op) {
    this.past.push(op);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.touch();
  }

  private touch() {
    this.sheet.updated = Date.now();
    this.onChange();
  }

  private apply(op: Op, forward: boolean) {
    const marks = this.sheet.marks;
    if (op.t === "add") {
      if (forward) {
        marks.push(op.m);
        this.withView(this.ictx, () => drawMarks(this.ictx, [op.m], null));
      } else {
        marks.pop();
        this.fullRender();
      }
    } else if (op.t === "edit") {
      marks[op.i] = forward ? op.to : op.from;
      this.fullRender();
    } else if (op.t === "del") {
      if (forward) marks.splice(op.i, 1);
      else marks.splice(op.i, 0, op.m);
      this.fullRender();
    } else if (op.t === "clear") {
      this.sheet.marks = forward ? [] : op.marks;
      this.fullRender();
    } else {
      this.sheet.bg = forward ? op.to : op.from;
      this.applyBackground();
    }
  }

  undo() {
    this.cancelStroke();
    this.cancelEdit();
    const op = this.past.pop();
    if (!op) return;
    this.apply(op, false);
    this.future.push(op);
    this.touch();
  }

  redo() {
    this.cancelStroke();
    this.cancelEdit();
    const op = this.future.pop();
    if (!op) return;
    this.apply(op, true);
    this.past.push(op);
    this.touch();
  }

  clear() {
    this.cancelStroke();
    this.cancelEdit();
    if (this.isEmpty) return;
    const op: Op = { t: "clear", marks: this.sheet.marks };
    this.apply(op, true);
    this.push(op);
  }

  setBackground(color: string) {
    if (color === this.sheet.bg) return;
    const op: Op = { t: "bg", from: this.sheet.bg, to: color };
    this.apply(op, true);
    this.push(op);
  }

  private addMark(m: Mark) {
    const op: Op = { t: "add", m };
    this.sheet.marks.push(m);
    this.push(op);
  }

  /**
   * Paper colour lives in a 1×1 canvas stretched over the stage. Browsers that force a dark
   * theme (Dark Reader, Samsung Internet, Opera…) recolour CSS backgrounds but never canvas
   * pixels, so the chosen paper always shows exactly as picked.
   */
  private applyBackground() {
    const bg = this.sheet.bg;
    this.stage.style.backgroundColor = bg;
    const c = this.stage.querySelector<HTMLCanvasElement>("#paper");
    const x = c?.getContext("2d");
    if (c && x) {
      x.clearRect(0, 0, 1, 1);
      x.fillStyle = bg;
      x.fillRect(0, 0, 1, 1);
    }
  }

  // ---------------------------------------------------------------- view

  toWorld(sx: number, sy: number): [number, number] {
    const v = this.view;
    return [(sx - v.x) / v.z, (sy - v.y) / v.z];
  }

  get zoom() {
    return this.view.z;
  }

  setView(v: View) {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z));
    this.view = { x: v.x, y: v.y, z };
    this.sheet.view = { ...this.view };
    this.scheduleViewRender();
    this.onView();
  }

  /** Zoom by `factor` keeping screen point (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number) {
    const v = this.view;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * factor));
    const k = z / v.z;
    this.setView({ x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k, z });
  }

  panBy(dx: number, dy: number) {
    this.setView({ x: this.view.x + dx, y: this.view.y + dy, z: this.view.z });
  }

  get isHomeView() {
    const v = this.view;
    return Math.abs(v.z - 1) < 0.01 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
  }

  /** Reset to 100 %; if the drawing doesn't fit, fit it to the screen instead. */
  fitView() {
    const b = union(this.sheet.marks);
    if (!b || (b.x0 >= 0 && b.y0 >= 0 && b.x1 <= this.cssW && b.y1 <= this.cssH)) {
      this.setView({ x: 0, y: 0, z: 1 });
      return;
    }
    const pad = 24;
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    const z = Math.min(1, (this.cssW - pad * 2) / w, (this.cssH - pad * 2) / h);
    this.setView({
      x: (this.cssW - w * z) / 2 - b.x0 * z,
      y: (this.cssH - h * z) / 2 - b.y0 * z,
      z,
    });
  }

  private visibleWorld(): BBox {
    const [x0, y0] = this.toWorld(0, 0);
    const [x1, y1] = this.toWorld(this.cssW, this.cssH);
    return { x0, y0, x1, y1 };
  }

  private scheduleViewRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.lastRenderMs <= FAST_RENDER_MS) {
        this.fullRender();
        return;
      }
      // Heavy sheet: move the existing bitmap on the GPU, repaint crisply once idle.
      const d = this.drawnView;
      const v = this.view;
      const k = v.z / d.z;
      this.ink.style.transform = `matrix(${k},0,0,${k},${v.x - d.x * k},${v.y - d.y * k})`;
      this.renderOverlay();
      clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => this.fullRender(), 140);
    });
  }

  /** Force a crisp repaint now (e.g. when a gesture ends). */
  settle() {
    if (this.drawnView.x !== this.view.x || this.drawnView.y !== this.view.y || this.drawnView.z !== this.view.z) {
      clearTimeout(this.idleTimer);
      this.fullRender();
    }
  }

  // ---------------------------------------------------------------- rendering

  private resize() {
    const rect = this.stage.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    // DPR capped at 2: visually crisp, but ~2× less fill work than 3× phones.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return;
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    for (const c of [this.ink, this.overlay]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.fullRender();
  }

  private withView(ctx: CanvasRenderingContext2D, fn: () => void) {
    const v = this.drawnView;
    const s = this.dpr * v.z;
    ctx.setTransform(s, 0, 0, s, this.dpr * v.x, this.dpr * v.y);
    fn();
    ctx.globalCompositeOperation = "source-over";
  }

  fullRender() {
    const t0 = performance.now();
    const ctx = this.ictx;
    this.drawnView = { ...this.view };
    this.ink.style.transform = "";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.ink.width, this.ink.height);
    this.withView(ctx, () => {
      drawMarks(ctx, this.sheet.marks, this.visibleWorld(), this.editing?.mark ?? null);
      if (this.live) this.redrawLive();
    });
    this.lastRenderMs = performance.now() - t0;
    this.renderOverlay();
  }

  // ---------------------------------------------------------------- live stroke

  get drawing() {
    return this.live !== null;
  }

  beginStroke(sx: number, sy: number, color: string, screenWidth: number, erase: boolean, pressure: number | null) {
    this.cancelStroke();
    this.settle();
    const width = screenWidth / this.view.z;
    const [x, y] = this.toWorld(sx, sy);
    const usePressure = pressure !== null;
    const sp = usePressure ? pressure : 1;
    const w0 = usePressure ? pressureWidth(width, sp) : width;
    this.live = { color, width, erase, pressure: usePressure, pts: [x, y], ws: [w0], box: emptyBox(), sp };
    grow(this.live.box, x, y, w0 / 2);
  }

  /** Append a point; returns false if it was too close to the last one. */
  extendStroke(sx: number, sy: number, pressure: number | null) {
    const s = this.live;
    if (!s) return false;
    const [x, y] = this.toWorld(sx, sy);
    const n = s.pts.length / 2;
    const dx = x - s.pts[2 * n - 2];
    const dy = y - s.pts[2 * n - 1];
    const minDist = 1 / this.view.z; // ≈ 1 screen px
    if (dx * dx + dy * dy < minDist * minDist) return false;
    let w = s.width;
    if (s.pressure && pressure !== null) {
      s.sp = s.sp * 0.6 + pressure * 0.4;
      w = pressureWidth(s.width, s.sp);
    }
    s.pts.push(x, y);
    s.ws.push(w);
    grow(s.box, x, y, w / 2);
    this.withView(this.ictx, () => {
      setStrokeStyle(this.ictx, s.color, s.erase);
      drawSegment(this.ictx, s.pts, n, (s.ws[n - 1] + w) / 2);
    });
    return true;
  }

  private redrawLive() {
    const s = this.live!;
    const ctx = this.ictx;
    setStrokeStyle(ctx, s.color, s.erase);
    const n = s.pts.length / 2;
    for (let i = 1; i < n; i++) drawSegment(ctx, s.pts, i, (s.ws[i - 1] + s.ws[i]) / 2);
  }

  endStroke() {
    const s = this.live;
    if (!s) return;
    this.live = null;
    const n = s.pts.length / 2;
    this.withView(this.ictx, () => {
      setStrokeStyle(this.ictx, s.color, s.erase);
      drawTail(this.ictx, s.pts, n, s.ws[n - 1]);
    });
    const constant = !s.pressure || s.ws.every((w) => Math.abs(w - s.ws[0]) < 0.05);
    const mark: Mark = {
      k: "pen",
      c: s.color,
      w: constant ? s.ws[0] : s.width,
      p: Float32Array.from(s.pts),
      b: s.box,
    };
    if (s.erase) mark.e = 1;
    if (!constant) mark.pw = Float32Array.from(s.ws);
    this.addMark(mark);
    this.renderOverlay();
  }

  /** Throw away an in-progress stroke (e.g. it was the start of a pinch). */
  cancelStroke() {
    if (!this.live) return;
    this.live = null;
    this.fullRender();
  }

  /** How long/far the live stroke is — used to decide cancel vs. keep on a 2nd finger. */
  liveLength() {
    const s = this.live;
    if (!s) return 0;
    let len = 0;
    for (let i = 2; i < s.pts.length; i += 2) len += Math.hypot(s.pts[i] - s.pts[i - 2], s.pts[i + 1] - s.pts[i - 1]);
    return len * this.view.z;
  }

  // ---------------------------------------------------------------- shapes & text

  private preview:
    | { k: "shape"; kind: ShapeKind; x1: number; y1: number; x2: number; y2: number; c: string; w: number; f: boolean }
    | ({ k: "text" } & TextDraft)
    | { k: "ring"; x: number; y: number; r: number }
    | null = null;

  previewShape(kind: ShapeKind, a: [number, number], b: [number, number], color: string, screenWidth: number, fill: boolean) {
    this.preview = { k: "shape", kind, x1: a[0], y1: a[1], x2: b[0], y2: b[1], c: color, w: screenWidth / this.view.z, f: fill };
    this.renderOverlay();
  }

  commitShape() {
    const p = this.preview;
    this.preview = null;
    if (!p || p.k !== "shape") return this.renderOverlay();
    const dist = Math.hypot(p.x2 - p.x1, p.y2 - p.y1) * this.view.z;
    if (dist >= 3) {
      const mark: Mark = { k: p.kind, c: p.c, w: p.w, x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, b: shapeBox(p.kind, p.x1, p.y1, p.x2, p.y2, p.w) };
      if (p.f && !OPEN_SHAPES.includes(p.kind)) mark.f = 1;
      this.withView(this.ictx, () => drawMarks(this.ictx, [mark], null));
      this.addMark(mark);
    }
    this.renderOverlay();
  }

  // ---- text: place new, pick up and edit existing

  /** A placed text being edited: hidden from the ink layer while its draft is shown on the overlay. */
  private editing: { i: number; mark: Mark } | null = null;

  get isEditingText() {
    return this.editing !== null;
  }

  /** Index of the topmost text under a screen point, or -1. */
  hitText(sx: number, sy: number): number {
    const [wx, wy] = this.toWorld(sx, sy);
    const slop = 8 / this.view.z;
    const marks = this.sheet.marks;
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i];
      if (m.k !== "text") continue;
      if (this.editing?.mark === m) continue;
      if (wx < m.b.x0 - slop || wx > m.b.x1 + slop || wy < m.b.y0 - slop || wy > m.b.y1 + slop) continue;
      if (this.inText(m.x, m.y, m.t, m.s, m.r ?? 0, wx, wy, slop)) return i;
    }
    return -1;
  }

  private inText(x: number, y: number, t: string, s: number, r: number, wx: number, wy: number, pad: number) {
    const { w, h } = draftBox({ t, s });
    const dx = wx - (x + w / 2);
    const dy = wy - (y + h / 2);
    const lx = dx * Math.cos(-r) - dy * Math.sin(-r);
    const ly = dx * Math.sin(-r) + dy * Math.cos(-r);
    return Math.abs(lx) <= w / 2 + pad && Math.abs(ly) <= h / 2 + pad;
  }

  /** Screen bounding rect of a placed text, for positioning hints. */
  textScreenRect(i: number): { x: number; y: number; w: number; h: number } | null {
    const m = this.sheet.marks[i];
    if (!m || m.k !== "text") return null;
    const v = this.view;
    return { x: m.b.x0 * v.z + v.x, y: m.b.y0 * v.z + v.y, w: (m.b.x1 - m.b.x0) * v.z, h: (m.b.y1 - m.b.y0) * v.z };
  }

  /** Pick a placed text up for editing; returns its draft (or null if `i` is not a text). */
  beginEdit(i: number): TextDraft | null {
    const m = this.sheet.marks[i];
    if (!m || m.k !== "text") return null;
    this.editing = { i, mark: m };
    this.fullRender();
    return { x: m.x, y: m.y, r: m.r ?? 0, t: m.t, c: m.c, s: m.s };
  }

  /** Put the picked-up text back untouched. */
  cancelEdit() {
    if (!this.editing) return;
    this.editing = null;
    this.fullRender();
  }

  /** Where the rotate handle sits relative to the box: above, or below when there is no room above. */
  private handleSide(d: TextDraft) {
    const { h } = draftBox(d);
    const cy = (d.y + h / 2) * this.view.z + this.view.y;
    return cy < 90 ? 1 : -1;
  }

  /** Which part of the draft is under a screen point: its rotate handle, its body, or nothing. */
  hitDraft(d: TextDraft, sx: number, sy: number): "rotate" | "body" | null {
    const [wx, wy] = this.toWorld(sx, sy);
    const u = 1 / this.view.z;
    const { w, h } = draftBox(d);
    const cx = d.x + w / 2;
    const cy = d.y + h / 2;
    const dist = h / 2 + 6 * u + 30 * u;
    const side = this.handleSide(d);
    const hx = cx - Math.sin(d.r) * side * dist;
    const hy = cy + Math.cos(d.r) * side * dist;
    if (Math.hypot(wx - hx, wy - hy) <= 24 * u) return "rotate";
    return this.inText(d.x, d.y, d.t, d.s, d.r, wx, wy, 14 * u + 6 * u) ? "body" : null;
  }

  /** Angle the draft must have so its rotate handle points at screen point (sx, sy). */
  angleTo(d: TextDraft, sx: number, sy: number): number {
    const [wx, wy] = this.toWorld(sx, sy);
    const { w, h } = draftBox(d);
    let r = Math.atan2(wy - (d.y + h / 2), wx - (d.x + w / 2)) + (this.handleSide(d) === -1 ? Math.PI / 2 : -Math.PI / 2);
    // soft snap to 15° steps near upright/right angles
    const step = Math.PI / 12;
    const near = Math.round(r / step) * step;
    if (Math.abs(r - near) < (3 * Math.PI) / 180) r = near;
    return Math.atan2(Math.sin(r), Math.cos(r));
  }

  /** Text being placed or edited: dashed field, blinking caret, rotate handle. */
  previewText(d: TextDraft) {
    this.preview = { k: "text", ...d };
    this.caretOn = true;
    if (!this.blinkTimer) {
      this.blinkTimer = window.setInterval(() => {
        this.caretOn = !this.caretOn;
        this.renderOverlay();
      }, 530);
    }
    this.renderOverlay();
  }

  /** Store the draft: a new mark, or (when a placed text was picked up) a change to it. */
  commitText(d: TextDraft) {
    this.preview = null;
    const ed = this.editing;
    this.editing = null;
    const t = d.t.trim();
    const fixed = retext(d, t);
    const mark: Mark | null = t
      ? { k: "text", c: fixed.c, s: fixed.s, x: fixed.x, y: fixed.y, t, b: textBBox(fixed.x, fixed.y, t, fixed.s, fixed.r) }
      : null;
    if (mark && fixed.r) mark.r = fixed.r;
    if (ed) {
      if (!mark) {
        this.sheet.marks.splice(ed.i, 1);
        this.push({ t: "del", i: ed.i, m: ed.mark });
      } else if (JSON.stringify({ ...mark, b: 0 }) !== JSON.stringify({ ...ed.mark, b: 0 })) {
        this.sheet.marks[ed.i] = mark;
        this.push({ t: "edit", i: ed.i, from: ed.mark, to: mark });
      }
      this.fullRender();
      return;
    }
    if (mark) {
      this.withView(this.ictx, () => drawMarks(this.ictx, [mark], null));
      this.addMark(mark);
    }
    this.renderOverlay();
  }

  /** Eraser/brush size ring under the pointer (null hides it). */
  ring(sx: number | null, sy = 0, screenWidth = 0) {
    if (sx === null) {
      if (this.preview?.k === "ring") {
        this.preview = null;
        this.renderOverlay();
      }
      return;
    }
    const [x, y] = this.toWorld(sx, sy);
    this.preview = { k: "ring", x, y, r: screenWidth / this.view.z / 2 };
    this.renderOverlay();
  }

  clearPreview() {
    if (!this.preview) return;
    this.preview = null;
    this.renderOverlay();
  }

  private caretOn = true;
  private blinkTimer = 0;

  private renderOverlay() {
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const p = this.preview;
    if (p?.k !== "text" && this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = 0;
    }
    if (!p) return;
    const v = this.view;
    const s = this.dpr * v.z;
    ctx.setTransform(s, 0, 0, s, this.dpr * v.x, this.dpr * v.y);
    if (p.k === "shape") drawShape(ctx, p.kind, p.x1, p.y1, p.x2, p.y2, p.c, p.w, p.f);
    else if (p.k === "text") {
      const u = 1 / v.z;
      const { w, h } = draftBox(p);
      const pad = 6 * u;
      const blue = "#0a84ff";
      ctx.translate(p.x + w / 2, p.y + h / 2);
      ctx.rotate(p.r);
      if (p.t) {
        ctx.translate(-w / 2, -h / 2);
        drawText(ctx, 0, 0, p.t, p.c, p.s);
        ctx.translate(w / 2, h / 2);
      }
      // Dashed field: where the text will land.
      ctx.lineWidth = 1.5 * u;
      ctx.setLineDash([5 * u, 4 * u]);
      ctx.strokeStyle = blue;
      ctx.beginPath();
      ctx.rect(-w / 2 - pad, -h / 2 - pad, w + 2 * pad, h + 2 * pad);
      ctx.stroke();
      ctx.setLineDash([]);
      if (this.caretOn) {
        ctx.fillStyle = blue;
        const cx = p.t ? w / 2 + u : -w / 2 + 2 * u;
        ctx.fillRect(cx, -h / 2, Math.max(2 * u, p.s * 0.06), p.s * 1.2);
      }
      // Rotate handle on a stem, on the side with room.
      const side = this.handleSide(p);
      const edge = side * (h / 2 + pad);
      const hy = side * (h / 2 + pad + 30 * u);
      ctx.lineWidth = 1.5 * u;
      ctx.beginPath();
      ctx.moveTo(0, edge);
      ctx.lineTo(0, hy);
      ctx.stroke();
      ctx.fillStyle = blue;
      ctx.beginPath();
      ctx.arc(0, hy, 12 * u, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2 * u;
      ctx.beginPath();
      ctx.arc(0, hy, 5.5 * u, -Math.PI * 0.15, Math.PI * 1.45);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      const ax = 5.5 * u * Math.cos(-Math.PI * 0.15);
      const ay = hy + 5.5 * u * Math.sin(-Math.PI * 0.15);
      ctx.moveTo(ax - 3.5 * u, ay - 1 * u);
      ctx.lineTo(ax + 3.5 * u, ay - 1 * u);
      ctx.lineTo(ax, ay + 4 * u);
      ctx.fill();
    } else {
      ctx.lineWidth = 1.5 / v.z;
      ctx.strokeStyle = "rgba(128,128,128,.9)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(p.r, 2 / v.z), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  get size() {
    return { w: this.cssW, h: this.cssH };
  }
}

function pressureWidth(base: number, p: number) {
  return base * (0.25 + 0.95 * Math.min(1, Math.max(0, p)));
}
