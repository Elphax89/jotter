import type { BBox, Mark, ShapeKind, TextDraft } from "./types";

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
      drawShape(ctx, m.k, m.x1, m.y1, m.x2, m.y2, m.c, m.w, !!m.f);
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

export function shapeBox(kind: ShapeKind, x1: number, y1: number, x2: number, y2: number, w: number): BBox {
  const r = w / 2 + 1;
  if (kind === "circle") {
    const rad = Math.hypot(x2 - x1, y2 - y1) + r;
    return { x0: x1 - rad, y0: y1 - rad, x1: x1 + rad, y1: y1 + rad };
  }
  const extra = kind === "arrow" ? arrowHead(w) : 0;
  return {
    x0: Math.min(x1, x2) - r - extra,
    y0: Math.min(y1, y2) - r - extra,
    x1: Math.max(x1, x2) + r + extra,
    y1: Math.max(y1, y2) + r + extra,
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
