import type { BBox, Frame, Mark, ShapeKind, TextDraft } from "./types";

export const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export function font(size: number) {
  return `500 ${size}px ${FONT_STACK}`;
}

export function emptyBox(): BBox {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

export function grow(b: BBox, x: number, y: number, r = 0) {
  if (x - r < b.x0) b.x0 = x - r;
  if (y - r < b.y0) b.y0 = y - r;
  if (x + r > b.x1) b.x1 = x + r;
  if (y + r > b.y1) b.y1 = y + r;
}

export function intersects(a: BBox, b: BBox) {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

export function union(marks: Mark[]): BBox | null {
  if (marks.length === 0) return null;
  const b = emptyBox();
  for (const m of marks) {
    if (m.k === "pen" && m.e) continue; // eraser strokes never extend the picture
    grow(b, m.b.x0, m.b.y0);
    grow(b, m.b.x1, m.b.y1);
  }
  return Number.isFinite(b.x0) ? b : null;
}

function setPaint(ctx: CanvasRenderingContext2D, color: string, erase: boolean) {
  if (erase) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = ctx.fillStyle = "#000";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = ctx.fillStyle = color;
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

/**
 * Stroke geometry, shared by live (incremental) and full rendering so both
 * look identical. For points P0…Pn-1 with midpoints Mi = mid(Pi-1, Pi):
 *   segment 1:  P0 → M1                        (line)
 *   segment i:  Mi-1 → Mi, control Pi-1        (quadratic)
 *   tail:       Mn-1 → Pn-1                    (line)
 * Every segment is final as soon as point i exists, so live drawing never
 * needs to repaint what is already on screen.
 */
export function drawSegment(
  ctx: CanvasRenderingContext2D,
  p: ArrayLike<number>,
  i: number,
  width: number,
) {
  const ax = p[2 * i - 2],
    ay = p[2 * i - 1],
    bx = p[2 * i],
    by = p[2 * i + 1];
  ctx.lineWidth = width;
  ctx.beginPath();
  if (i === 1) {
    ctx.moveTo(ax, ay);
    ctx.lineTo((ax + bx) / 2, (ay + by) / 2);
  } else {
    const px = p[2 * i - 4],
      py = p[2 * i - 3];
    ctx.moveTo((px + ax) / 2, (py + ay) / 2);
    ctx.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2);
  }
  ctx.stroke();
}

export function drawTail(ctx: CanvasRenderingContext2D, p: ArrayLike<number>, n: number, width: number) {
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const ax = p[2 * n - 4],
    ay = p[2 * n - 3],
    bx = p[2 * n - 2],
    by = p[2 * n - 1];
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo((ax + bx) / 2, (ay + by) / 2);
  ctx.lineTo(bx, by);
  ctx.stroke();
}

export function setStrokeStyle(ctx: CanvasRenderingContext2D, color: string, erase: boolean) {
  setPaint(ctx, color, erase);
}

function drawPen(ctx: CanvasRenderingContext2D, m: Extract<Mark, { k: "pen" }>) {
  const p = m.p;
  const n = p.length / 2;
  setPaint(ctx, m.c, !!m.e);
  if (m.pw) {
    const pw = m.pw;
    for (let i = 1; i < n; i++) drawSegment(ctx, p, i, (pw[i - 1] + pw[i]) / 2);
    drawTail(ctx, p, n, pw[n - 1]);
    return;
  }
  // Constant width: one path is cheaper than many segments and looks the same.
  if (n === 1) {
    drawTail(ctx, p, 1, m.w);
    return;
  }
  ctx.lineWidth = m.w;
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  ctx.lineTo((p[0] + p[2]) / 2, (p[1] + p[3]) / 2);
  for (let i = 2; i < n; i++) {
    const ax = p[2 * i - 2],
      ay = p[2 * i - 1];
    ctx.quadraticCurveTo(ax, ay, (ax + p[2 * i]) / 2, (ay + p[2 * i + 1]) / 2);
  }
  ctx.lineTo(p[2 * n - 2], p[2 * n - 1]);
  ctx.stroke();
}

const arrowHead = (width: number) => Math.max(12, width * 4.5);

/** Shapes that keep a rotation of their own (lines and circles are rotated by moving their points). */
export const ROTATABLE: ShapeKind[] = ["rect", "ellipse", "triangle", "cuboid"];

export function drawShape(
  ctx: CanvasRenderingContext2D,
  kind: ShapeKind,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width: number,
  fill: boolean,
  r = 0,
) {
  if (!r || !ROTATABLE.includes(kind)) return drawShapeRaw(ctx, kind, x1, y1, x2, y2, color, width, fill);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(r);
  ctx.translate(-cx, -cy);
  drawShapeRaw(ctx, kind, x1, y1, x2, y2, color, width, fill);
  ctx.restore();
}

function drawShapeRaw(
  ctx: CanvasRenderingContext2D,
  kind: ShapeKind,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width: number,
  fill: boolean,
) {
  setPaint(ctx, color, false);
  ctx.lineWidth = width;
  ctx.beginPath();
  switch (kind) {
    case "line":
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      return;
    case "arrow": {
      const len = Math.hypot(x2 - x1, y2 - y1);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      if (len > 2) {
        const hl = Math.min(arrowHead(width), len * 0.6);
        const a = Math.atan2(y2 - y1, x2 - x1);
        for (const d of [-0.5, 0.5]) {
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - hl * Math.cos(a + d), y2 - hl * Math.sin(a + d));
        }
      }
      ctx.stroke();
      return;
    }
    case "rect":
      ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      break;
    case "ellipse": {
      const rx = Math.abs(x2 - x1) / 2;
      const ry = Math.abs(y2 - y1) / 2;
      if (rx < 0.25 || ry < 0.25) return;
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, rx, ry, 0, 0, Math.PI * 2);
      break;
    }
    case "circle": {
      // centre = where you started, radius = how far you drag
      const r = Math.hypot(x2 - x1, y2 - y1);
      if (r < 0.25) return;
      ctx.arc(x1, y1, r, 0, Math.PI * 2);
      break;
    }
    case "triangle":
      if (Math.abs(x2 - x1) < 1 || Math.abs(y2 - y1) < 1) return;
      ctx.moveTo((x1 + x2) / 2, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x1, y2);
      ctx.closePath();
      break;
    case "cuboid": {
      const x0 = Math.min(x1, x2);
      const xe = Math.max(x1, x2);
      const y0 = Math.min(y1, y2);
      const ye = Math.max(y1, y2);
      const d = Math.min(xe - x0, ye - y0) * 0.3;
      if (d < 1) return;
      const front = () => {
        ctx.beginPath();
        ctx.rect(x0, y0 + d, xe - x0 - d, ye - y0 - d);
      };
      const top = () => {
        ctx.beginPath();
        ctx.moveTo(x0, y0 + d);
        ctx.lineTo(x0 + d, y0);
        ctx.lineTo(xe, y0);
        ctx.lineTo(xe - d, y0 + d);
        ctx.closePath();
      };
      const side = () => {
        ctx.beginPath();
        ctx.moveTo(xe - d, y0 + d);
        ctx.lineTo(xe, y0);
        ctx.lineTo(xe, ye - d);
        ctx.lineTo(xe - d, ye);
        ctx.closePath();
      };
      // filled: the faces get different strengths of the colour so it reads as a solid
      const faces: [() => void, number][] = [[front, 1], [top, 0.55], [side, 0.8]];
      for (const [path, alpha] of faces) {
        path();
        if (fill) {
          ctx.globalAlpha = alpha;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.stroke();
      }
      return;
    }
  }
  if (fill) ctx.fill();
  ctx.stroke();
}

let measurer: CanvasRenderingContext2D | null = null;

/** Size of a text line in world units (unrotated). */
export function measureText(text: string, size: number): { w: number; h: number } {
  measurer ??= document.createElement("canvas").getContext("2d")!;
  measurer.font = font(size);
  return { w: measurer.measureText(text).width, h: size * 1.25 };
}

/** Corner points of the (padded) text box, rotated around its centre. */
export function textCorners(x: number, y: number, w: number, h: number, r: number, pad = 0): [number, number][] {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const hw = w / 2 + pad;
  const hh = h / 2 + pad;
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as [number, number][]).map(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]);
}

/** Axis-aligned box around a (rotated) text. */
export function textBBox(x: number, y: number, text: string, size: number, r = 0): BBox {
  const { w, h } = measureText(text, size);
  const b = emptyBox();
  for (const [px, py] of textCorners(x, y, w, h, r, 2)) grow(b, px, py);
  return b;
}

/** Box of a draft: an empty draft still shows a field two letters wide. */
export function draftBox(d: Pick<TextDraft, "t" | "s">): { w: number; h: number } {
  return d.t ? measureText(d.t, d.s) : { w: d.s * 2, h: d.s * 1.25 };
}

/** New text, keeping the left edge (in the rotated direction) where it was, so typing grows to the right. */
export function retext(d: TextDraft, t: string): TextDraft {
  const a = draftBox(d);
  const b = draftBox({ t, s: d.s });
  const k = (b.w - a.w) / 2;
  return { ...d, t, x: d.x - (b.w - a.w) / 2 + k * Math.cos(d.r), y: d.y + k * Math.sin(d.r) };
}

/** New font size around the same centre. */
export function resizeText(d: TextDraft, s: number): TextDraft {
  const a = draftBox(d);
  const b = draftBox({ t: d.t, s });
  return { ...d, s, x: d.x + (a.w - b.w) / 2, y: d.y + (a.h - b.h) / 2 };
}

export function drawText(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, size: number, r = 0) {
  setPaint(ctx, color, false);
  ctx.font = font(size);
  ctx.textBaseline = "top";
  if (!r) {
    ctx.fillText(text, x, y);
    return;
  }
  const { w, h } = measureText(text, size);
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(r);
  ctx.fillText(text, -w / 2, -h / 2);
  ctx.restore();
}

export function drawMark(ctx: CanvasRenderingContext2D, m: Mark) {
  switch (m.k) {
    case "pen":
      drawPen(ctx, m);
      break;
    case "text":
      drawText(ctx, m.x, m.y, m.t, m.c, m.s, m.r);
      break;
    default:
      drawShape(ctx, m.k, m.x1, m.y1, m.x2, m.y2, m.c, m.w, !!m.f, m.r);
  }
}

/** Draw all marks that touch `visible` (culling keeps zoomed-in views fast). */
export function drawMarks(ctx: CanvasRenderingContext2D, marks: Mark[], visible: BBox | null, skip: Mark | null = null) {
  for (const m of marks) {
    if (m === skip) continue;
    if (visible && !intersects(m.b, visible)) continue;
    drawMark(ctx, m);
  }
  ctx.globalCompositeOperation = "source-over";
}

export function shapeBox(kind: ShapeKind, x1: number, y1: number, x2: number, y2: number, w: number, rot = 0): BBox {
  const r = w / 2 + 1;
  if (kind === "circle") {
    const rad = Math.hypot(x2 - x1, y2 - y1) + r;
    return { x0: x1 - rad, y0: y1 - rad, x1: x1 + rad, y1: y1 + rad };
  }
  if (rot && ROTATABLE.includes(kind)) {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const hw = Math.abs(x2 - x1) / 2 + r;
    const hh = Math.abs(y2 - y1) / 2 + r;
    const ex = Math.abs(hw * Math.cos(rot)) + Math.abs(hh * Math.sin(rot));
    const ey = Math.abs(hw * Math.sin(rot)) + Math.abs(hh * Math.cos(rot));
    return { x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey };
  }
  const extra = kind === "arrow" ? arrowHead(w) : 0;
  return {
    x0: Math.min(x1, x2) - r - extra,
    y0: Math.min(y1, y2) - r - extra,
    x1: Math.max(x1, x2) + r + extra,
    y1: Math.max(y1, y2) + r + extra,
  };
}

// ---------------------------------------------------------------- selection geometry

/** The box a picked-up mark shows (centre, half size, base angle). */
export function markFrame(m: Mark): Frame {
  if (m.k === "pen") {
    const b = m.b;
    return { px: (b.x0 + b.x1) / 2, py: (b.y0 + b.y1) / 2, hw: (b.x1 - b.x0) / 2, hh: (b.y1 - b.y0) / 2, a0: 0 };
  }
  if (m.k === "text") {
    const { w, h } = measureText(m.t, m.s);
    return { px: m.x + w / 2, py: m.y + h / 2, hw: w / 2, hh: h / 2, a0: m.r ?? 0 };
  }
  const half = m.w / 2;
  if (m.k === "line" || m.k === "arrow") {
    const len = Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
    const head = m.k === "arrow" ? Math.min(arrowHead(m.w), len * 0.6) * 0.5 : 0;
    return { px: (m.x1 + m.x2) / 2, py: (m.y1 + m.y2) / 2, hw: len / 2 + half, hh: Math.max(half, head), a0: Math.atan2(m.y2 - m.y1, m.x2 - m.x1) };
  }
  if (m.k === "circle") {
    const rad = Math.hypot(m.x2 - m.x1, m.y2 - m.y1) + half;
    return { px: m.x1, py: m.y1, hw: rad, hh: rad, a0: 0 };
  }
  return {
    px: (m.x1 + m.x2) / 2,
    py: (m.y1 + m.y2) / 2,
    hw: Math.abs(m.x2 - m.x1) / 2 + half,
    hh: Math.abs(m.y2 - m.y1) / 2 + half,
    a0: m.r ?? 0,
  };
}

/**
 * Bake a move / rotation / scale / recolour into a new mark.
 * Every point p goes to  P + d + R(rot)·k·(p − P)  with P the pivot.
 */
export function transformMark(m: Mark, px: number, py: number, dx: number, dy: number, rot: number, k: number, color: string): Mark {
  const cos = Math.cos(rot) * k;
  const sin = Math.sin(rot) * k;
  const T = (x: number, y: number): [number, number] => {
    const ux = x - px;
    const uy = y - py;
    return [px + dx + ux * cos - uy * sin, py + dy + ux * sin + uy * cos];
  };
  const angle = (a: number | undefined) => {
    const v = Math.atan2(Math.sin((a ?? 0) + rot), Math.cos((a ?? 0) + rot));
    return Math.abs(v) < 1e-6 ? undefined : v;
  };

  if (m.k === "pen") {
    const p = new Float32Array(m.p.length);
    const b = emptyBox();
    const pw = m.pw ? m.pw.map((w) => w * k) : undefined;
    for (let i = 0; i < m.p.length; i += 2) {
      const [x, y] = T(m.p[i], m.p[i + 1]);
      p[i] = x;
      p[i + 1] = y;
      grow(b, x, y, (pw ? pw[i / 2] : m.w * k) / 2 + 1);
    }
    const out: Mark = { k: "pen", c: color, w: m.w * k, p, b };
    if (pw) out.pw = pw;
    if (m.e) out.e = 1;
    return out;
  }
  if (m.k === "text") {
    const a = measureText(m.t, m.s);
    const [cx, cy] = T(m.x + a.w / 2, m.y + a.h / 2);
    const s = m.s * k;
    const n = measureText(m.t, s);
    const x = cx - n.w / 2;
    const y = cy - n.h / 2;
    const r = angle(m.r);
    const out: Mark = { k: "text", c: color, s, x, y, t: m.t, b: textBBox(x, y, m.t, s, r ?? 0) };
    if (r !== undefined) out.r = r;
    return out;
  }
  const w = m.w * k;
  let x1: number, y1: number, x2: number, y2: number;
  let r: number | undefined;
  if (m.k === "line" || m.k === "arrow") {
    [x1, y1] = T(m.x1, m.y1);
    [x2, y2] = T(m.x2, m.y2);
  } else if (m.k === "circle") {
    [x1, y1] = T(m.x1, m.y1);
    x2 = x1 + (m.x2 - m.x1) * k;
    y2 = y1 + (m.y2 - m.y1) * k;
  } else {
    const [cx, cy] = T((m.x1 + m.x2) / 2, (m.y1 + m.y2) / 2);
    const hx = ((m.x2 - m.x1) / 2) * k;
    const hy = ((m.y2 - m.y1) / 2) * k;
    x1 = cx - hx;
    x2 = cx + hx;
    y1 = cy - hy;
    y2 = cy + hy;
    r = angle(m.r);
  }
  const out: Mark = { k: m.k, c: color, w, x1, y1, x2, y2, b: shapeBox(m.k, x1, y1, x2, y2, w, r ?? 0) };
  if (m.f) out.f = 1;
  if (r !== undefined) out.r = r;
  return out;
}

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const vx = bx - ax;
  const vy = by - ay;
  const l = vx * vx + vy * vy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l)) : 0;
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
};

function nearPoly(pts: [number, number][], x: number, y: number, tol: number) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (segDist(x, y, a[0], a[1], b[0], b[1]) <= tol) return true;
  }
  return false;
}

function inPoly(pts: [number, number][], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is world point (x, y) on this mark (within `slop`)? Eraser strokes never are. */
export function hitMark(m: Mark, x: number, y: number, slop: number): boolean {
  const b = m.b;
  if (x < b.x0 - slop || x > b.x1 + slop || y < b.y0 - slop || y > b.y1 + slop) return false;
  if (m.k === "pen") {
    if (m.e) return false;
    const p = m.p;
    if (p.length < 4) return Math.hypot(x - p[0], y - p[1]) <= m.w / 2 + slop;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const w = m.pw ? Math.max(m.pw[i / 2], m.pw[i / 2 + 1]) : m.w;
      if (segDist(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= w / 2 + slop) return true;
    }
    return false;
  }
  if (m.k === "text") {
    const f = markFrame(m);
    const dx = x - f.px;
    const dy = y - f.py;
    const lx = dx * Math.cos(-f.a0) - dy * Math.sin(-f.a0);
    const ly = dx * Math.sin(-f.a0) + dy * Math.cos(-f.a0);
    return Math.abs(lx) <= f.hw + slop && Math.abs(ly) <= f.hh + slop;
  }
  const tol = m.w / 2 + slop;
  if (m.k === "line" || m.k === "arrow") return segDist(x, y, m.x1, m.y1, m.x2, m.y2) <= tol + (m.k === "arrow" ? 4 : 0);
  if (m.k === "circle") {
    const rad = Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
    const d = Math.hypot(x - m.x1, y - m.y1);
    return m.f ? d <= rad + tol : Math.abs(d - rad) <= tol;
  }
  // into the shape's own (unrotated) frame
  const cx = (m.x1 + m.x2) / 2;
  const cy = (m.y1 + m.y2) / 2;
  const r = -(m.r ?? 0);
  const lx = cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r);
  const ly = cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r);
  const x0 = Math.min(m.x1, m.x2);
  const xe = Math.max(m.x1, m.x2);
  const y0 = Math.min(m.y1, m.y2);
  const ye = Math.max(m.y1, m.y2);
  if (m.k === "ellipse") {
    const rx = (xe - x0) / 2;
    const ry = (ye - y0) / 2;
    const n = Math.hypot((lx - cx) / rx, (ly - cy) / ry);
    return m.f ? n <= 1 + tol / Math.min(rx, ry) : Math.abs(n - 1) * Math.min(rx, ry) <= tol;
  }
  let polys: [number, number][][];
  if (m.k === "rect") polys = [[[x0, y0], [xe, y0], [xe, ye], [x0, ye]]];
  else if (m.k === "triangle") polys = [[[cx, m.y1], [m.x2, m.y2], [m.x1, m.y2]]];
  else {
    const d = Math.min(xe - x0, ye - y0) * 0.3;
    polys = [
      [[x0, y0 + d], [xe - d, y0 + d], [xe - d, ye], [x0, ye]],
      [[x0, y0 + d], [x0 + d, y0], [xe, y0], [xe - d, y0 + d]],
      [[xe - d, y0 + d], [xe, y0], [xe, ye - d], [xe - d, ye]],
    ];
  }
  return polys.some((pts) => (m.f && inPoly(pts, lx, ly)) || nearPoly(pts, lx, ly, tol));
}

/** Render a sheet region to a standalone canvas (export, thumbnails). */
export function renderRegion(
  marks: Mark[],
  bg: string,
  region: BBox,
  scale: number,
): HTMLCanvasElement {
  const w = Math.max(1, Math.round((region.x1 - region.x0) * scale));
  const h = Math.max(1, Math.round((region.y1 - region.y0) * scale));
  // Ink on its own layer so the eraser reveals paper instead of punching holes.
  const ink = document.createElement("canvas");
  ink.width = w;
  ink.height = h;
  const ictx = ink.getContext("2d")!;
  ictx.setTransform(scale, 0, 0, scale, -region.x0 * scale, -region.y0 * scale);
  drawMarks(ictx, marks, region);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d")!;
  octx.fillStyle = bg;
  octx.fillRect(0, 0, w, h);
  octx.drawImage(ink, 0, 0);
  return out;
}
