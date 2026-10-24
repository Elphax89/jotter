import type { BBox, Mark, ShapeKind } from "./types";

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
) {
  setPaint(ctx, color, false);
  ctx.lineWidth = width;
  ctx.beginPath();
  if (kind === "line") {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    return;
  }
  if (kind === "rect") {
    ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  } else {
    const rx = Math.abs(x2 - x1) / 2;
    const ry = Math.abs(y2 - y1) / 2;
    if (rx < 0.25 || ry < 0.25) return;
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, rx, ry, 0, 0, Math.PI * 2);
  }
  if (fill) ctx.fill();
  ctx.stroke();
}

export function drawText(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, size: number) {
  setPaint(ctx, color, false);
  ctx.font = font(size);
  ctx.textBaseline = "top";
  ctx.fillText(text, x, y);
}

export function drawMark(ctx: CanvasRenderingContext2D, m: Mark) {
  switch (m.k) {
    case "pen":
      drawPen(ctx, m);
      break;
    case "text":
      drawText(ctx, m.x, m.y, m.t, m.c, m.s);
      break;
    default:
      drawShape(ctx, m.k, m.x1, m.y1, m.x2, m.y2, m.c, m.w, !!m.f);
  }
}

/** Draw all marks that touch `visible` (culling keeps zoomed-in views fast). */
export function drawMarks(ctx: CanvasRenderingContext2D, marks: Mark[], visible: BBox | null) {
  for (const m of marks) {
    if (visible && !intersects(m.b, visible)) continue;
    drawMark(ctx, m);
  }
  ctx.globalCompositeOperation = "source-over";
}

export function shapeBox(x1: number, y1: number, x2: number, y2: number, w: number): BBox {
  const r = w / 2 + 1;
  return {
    x0: Math.min(x1, x2) - r,
    y0: Math.min(y1, y2) - r,
    x1: Math.max(x1, x2) + r,
    y1: Math.max(y1, y2) + r,
  };
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
