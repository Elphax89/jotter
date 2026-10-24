import type { Board } from "./board";
import type { ShapeKind, Tool } from "./types";

export interface Brush {
  tool: Tool;
  shape: ShapeKind;
  color: string;
  size: number;
  fill: boolean;
}

export interface InputDeps {
  board: Board;
  brush(): Brush;
  /** return true to swallow the touch (e.g. it only closes a popover) */
  intercept(): boolean;
  onTextTap(at: [number, number]): void;
  onUndo(): void;
  onRedo(): void;
  onPenDetected(): void;
  onDrawStart(): void;
}

interface Ptr {
  type: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
}

type Mode = "idle" | "draw" | "shape" | "gesture" | "pan";

const TAP_MS = 350;
const TAP_SLOP = 12;
/** a stroke this young/short when a 2nd finger lands was really the start of a pinch */
const YOUNG_MS = 260;
const YOUNG_PX = 24;

const PEN_KEY = "jotter.penSeen";

/**
 * Pointer handling:
 * - 1 finger / mouse / stylus → draw with the current tool
 * - 2 fingers → pinch-zoom & pan; quick 2-finger tap = undo, 3-finger tap = redo
 * - once a stylus is seen, fingers only navigate (palm rejection)
 * - mouse: wheel pans, Ctrl/⌘+wheel or trackpad pinch zooms, middle button / Space drags
 */
export function attachInput(stage: HTMLElement, deps: InputDeps) {
  const { board } = deps;
  const ptrs = new Map<number, Ptr>();
  let mode: Mode = "idle";
  let drawId = -1;
  let drawType = "";
  let drawT0 = 0;
  let shapeStart: [number, number] = [0, 0];
  let erasing = false;
  let rect = stage.getBoundingClientRect();
  let space = false;
  let penSeen = readFlag();

  let chord: { max: number; t0: number; moved: boolean } | null = null;
  let gest: { ids: number[]; cx: number; cy: number; d: number; v: { x: number; y: number; z: number } } | null = null;
  let panPtr: { id: number; x: number; y: number } | null = null;

  const local = (e: { clientX: number; clientY: number }): [number, number] => [e.clientX - rect.left, e.clientY - rect.top];
  const pressure = (e: PointerEvent) => (e.pointerType === "pen" && e.pressure > 0 ? e.pressure : null);
  const touches = () => [...ptrs.entries()].filter(([, p]) => p.type === "touch").map(([id]) => id);

  function startGesture() {
    const ids = touches().slice(0, 2);
    if (ids.length === 0) {
      gest = null;
      return;
    }
    const [cx, cy, d] = measure(ids);
    gest = { ids, cx, cy, d, v: { ...board.view } };
  }

  function measure(ids: number[]): [number, number, number] {
    const a = ptrs.get(ids[0])!;
    const b = ptrs.get(ids[1] ?? ids[0])!;
    return [(a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y)];
  }

  function updateGesture() {
    if (!gest) return;
    const [cx, cy, d] = measure(gest.ids);
    const v0 = gest.v;
    if (gest.ids.length === 2 && gest.d > 10) {
      const z = Math.min(8, Math.max(0.2, (v0.z * d) / gest.d));
      const wx = (gest.cx - v0.x) / v0.z;
      const wy = (gest.cy - v0.y) / v0.z;
      board.setView({ x: cx - wx * z, y: cy - wy * z, z });
    } else {
      board.setView({ x: v0.x + cx - gest.cx, y: v0.y + cy - gest.cy, z: v0.z });
    }
  }

  function startDraw(e: PointerEvent) {
    const b = deps.brush();
    const [sx, sy] = local(e);
    deps.onDrawStart();
    if (b.tool === "text") {
      deps.onTextTap(board.toWorld(sx, sy));
      return;
    }
    drawId = e.pointerId;
    drawType = e.pointerType;
    drawT0 = e.timeStamp;
    if (b.tool === "shape") {
      mode = "shape";
      shapeStart = board.toWorld(sx, sy);
      board.previewShape(b.shape, shapeStart, shapeStart, b.color, b.size, b.fill);
      return;
    }
    mode = "draw";
    // Stylus eraser end / eraser button (Surface, Wacom) erases too.
    erasing = b.tool === "eraser" || (e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32) !== 0));
    board.beginStroke(sx, sy, b.color, eraserSize(b), erasing, erasing ? null : pressure(e));
    if (erasing && e.pointerType !== "touch") board.ring(sx, sy, eraserSize(b));
  }

  // Stylus eraser button while the pen tool is active: use a generous size.
  const eraserSize = (b: Brush) => (b.tool !== "eraser" && erasing ? Math.max(b.size * 3, 24) : b.size);

  function endDraw(cancel: boolean) {
    if (mode === "draw") {
      if (cancel) board.cancelStroke();
      else board.endStroke();
      board.ring(null);
    } else if (mode === "shape") {
      if (cancel) board.clearPreview();
      else board.commitShape();
    }
    mode = "idle";
    drawId = -1;
    erasing = false;
  }

  function startPan(e: PointerEvent) {
    mode = "pan";
    const [x, y] = local(e);
    panPtr = { id: e.pointerId, x, y };
  }

  stage.addEventListener("pointerdown", (e) => {
    if (deps.intercept()) {
      e.preventDefault();
      return;
    }
    rect = stage.getBoundingClientRect();
    const [x, y] = local(e);
    const type = e.pointerType;

    if (type === "touch" && (mode === "draw" || mode === "shape") && drawType !== "touch") return; // palm while stylus draws

    ptrs.set(e.pointerId, { type, x, y, sx: x, sy: y });
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }

    if (type === "pen" && !penSeen) {
      penSeen = true;
      writeFlag();
      deps.onPenDetected();
    }

    if (type === "touch") {
      const n = touches().length;
      if (n === 1) chord = { max: 1, t0: e.timeStamp, moved: false };
      else if (chord) chord.max = Math.max(chord.max, n);

      if (n >= 2) {
        if ((mode === "draw" || mode === "shape") && drawType === "touch") {
          const young = e.timeStamp - drawT0 < YOUNG_MS || (mode === "draw" && board.liveLength() < YOUNG_PX);
          endDraw(young || mode === "shape");
        }
        mode = "gesture";
        panPtr = null;
        startGesture();
        return;
      }
      if (mode !== "idle") return;
      if (penSeen) startPan(e);
      else startDraw(e);
      return;
    }

    if (type === "mouse") {
      if (e.button === 1 || (e.button === 0 && space)) {
        e.preventDefault();
        startPan(e);
        return;
      }
      if (e.button !== 0 || mode !== "idle") return;
      startDraw(e);
      return;
    }

    // stylus
    if ((mode === "draw" || mode === "shape") && drawType === "touch") endDraw(true);
    if (mode === "gesture" || mode === "pan") {
      gest = null;
      panPtr = null;
      board.settle();
      mode = "idle";
    }
    if (mode === "idle") startDraw(e);
  });

  stage.addEventListener("pointermove", (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) {
      // hover: show eraser size for mouse / hovering stylus
      const b = deps.brush();
      if (b.tool === "eraser" && e.pointerType !== "touch" && mode === "idle") {
        const [sx, sy] = local(e);
        board.ring(sx, sy, eraserSize(b));
      }
      return;
    }
    const [x, y] = local(e);
    p.x = x;
    p.y = y;
    if (chord && p.type === "touch" && Math.hypot(x - p.sx, y - p.sy) > TAP_SLOP) chord.moved = true;

    if (mode === "draw" && e.pointerId === drawId) {
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      const list = events.length ? events : [e];
      for (const ev of list) {
        const [sx, sy] = local(ev);
        board.extendStroke(sx, sy, erasing ? null : pressure(ev));
      }
      if (erasing && e.pointerType !== "touch") board.ring(x, y, eraserSize(deps.brush()));
    } else if (mode === "shape" && e.pointerId === drawId) {
      const b = deps.brush();
      let end = board.toWorld(x, y);
      if (e.shiftKey) end = constrain(b.shape, shapeStart, end);
      board.previewShape(b.shape, shapeStart, end, b.color, b.size, b.fill);
    } else if (mode === "gesture") {
      updateGesture();
    } else if (mode === "pan" && panPtr && e.pointerId === panPtr.id) {
      board.panBy(x - panPtr.x, y - panPtr.y);
      panPtr.x = x;
      panPtr.y = y;
    }
  });

  const release = (e: PointerEvent) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    ptrs.delete(e.pointerId);
    const cancelled = e.type === "pointercancel";

    if ((mode === "draw" || mode === "shape") && e.pointerId === drawId) {
      // Keep strokes even on a system cancel — losing a drawing is worse than a stray line.
      endDraw(cancelled && mode === "shape");
    } else if (mode === "gesture") {
      if (touches().length > 0) startGesture();
      else {
        gest = null;
        mode = "idle";
        board.settle();
      }
    } else if (mode === "pan" && panPtr && e.pointerId === panPtr.id) {
      panPtr = null;
      mode = "idle";
      board.settle();
    }

    if (p.type === "touch" && touches().length === 0 && chord) {
      const c = chord;
      chord = null;
      if (!cancelled && !c.moved && e.timeStamp - c.t0 < TAP_MS) {
        if (c.max === 2) deps.onUndo();
        else if (c.max === 3) deps.onRedo();
      }
    }
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);
  stage.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "touch" && !ptrs.has(e.pointerId)) board.ring(null);
  });
  stage.addEventListener("contextmenu", (e) => e.preventDefault());

  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      rect = stage.getBoundingClientRect();
      const [sx, sy] = local(e);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.ctrlKey || e.metaKey) {
        board.zoomAt(sx, sy, Math.exp((-e.deltaY * unit) / 300));
      } else {
        board.panBy(-e.deltaX * unit, -e.deltaY * unit);
      }
      scheduleSettle();
    },
    { passive: false },
  );

  let settleTimer = 0;
  function scheduleSettle() {
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => board.settle(), 160);
  }

  // iOS Safari: stop the page itself from pinch-zooming.
  for (const type of ["gesturestart", "gesturechange"]) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false } as AddEventListenerOptions);
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === " " && !isTyping(e.target)) {
      space = true;
      stage.style.cursor = "grab";
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      space = false;
      stage.style.cursor = "";
    }
  });

  return {
    /** fingers draw again (e.g. user turned palm rejection off) */
    resetPen() {
      penSeen = false;
      writeFlag();
    },
    /** palm rejection on/off (on = fingers only zoom & pan) */
    setPenSeen(v: boolean) {
      penSeen = v;
      writeFlag();
    },
    get penSeen() {
      return penSeen;
    },
  };

  function readFlag() {
    try {
      return localStorage.getItem(PEN_KEY) === "1";
    } catch {
      return false;
    }
  }
  function writeFlag() {
    try {
      localStorage.setItem(PEN_KEY, penSeen ? "1" : "0");
    } catch {
      /* private mode */
    }
  }
}

export function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** Shift: 45° lines, squares, circles. */
function constrain(kind: ShapeKind, a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (kind === "line") {
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len];
  }
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  return [a[0] + Math.sign(dx || 1) * s, a[1] + Math.sign(dy || 1) * s];
}
