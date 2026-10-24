/** Axis-aligned bounding box in world units. */
export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type ShapeKind = "line" | "rect" | "ellipse";

/**
 * A single drawn element. World units = CSS pixels at zoom 1.
 * Kept compact on purpose: sheets with thousands of strokes stay small in IndexedDB.
 */
export type Mark =
  | {
      k: "pen";
      /** colour (ignored when erasing) */
      c: string;
      /** base width */
      w: number;
      /** eraser stroke */
      e?: 1;
      /** flat points [x0, y0, x1, y1, …] */
      p: Float32Array;
      /** optional per-point width (pressure-sensitive strokes) */
      pw?: Float32Array;
      b: BBox;
    }
  | {
      k: ShapeKind;
      c: string;
      w: number;
      /** filled */
      f?: 1;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      b: BBox;
    }
  | {
      k: "text";
      c: string;
      /** font size */
      s: number;
      x: number;
      y: number;
      t: string;
      b: BBox;
    };

export interface View {
  /** translation in CSS px */
  x: number;
  y: number;
  /** zoom factor */
  z: number;
}

export interface Sheet {
  id: string;
  created: number;
  updated: number;
  bg: string;
  marks: Mark[];
  view: View;
}

/** Lightweight entry for the gallery (no stroke data). */
export interface SheetMeta {
  id: string;
  created: number;
  updated: number;
  bg: string;
  n: number;
  thumb?: Blob;
}

export type Tool = "pen" | "shape" | "eraser" | "text";
