/** Axis-aligned bounding box in world units. */
export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type ShapeKind = "line" | "arrow" | "rect" | "ellipse" | "circle" | "triangle" | "cuboid";

/** Shapes drawn as an outline only. */
export const OPEN_SHAPES: ShapeKind[] = ["line", "arrow"];

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
      /** rotation in radians around the shape's centre (rect, oval, triangle, cuboid) */
      r?: number;
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
      /** rotation in radians around the text's centre */
      r?: number;
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
  /** user-given name; empty = untitled */
  name: string;
  created: number;
  /** last change (autosave) */
  updated: number;
  /** time it was stored in the list; unset = not saved (yet) */
  savedAt?: number;
  bg: string;
  marks: Mark[];
  view: View;
}

/** Lightweight entry for the gallery (no stroke data). */
export interface SheetMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
  savedAt?: number;
  bg: string;
  n: number;
  thumb?: Blob;
}

export type Tool = "pen" | "shape" | "eraser" | "text";

/** Text being placed or edited. `x`,`y` = top-left of the unrotated box, `s` = font size in world units. */
export interface TextDraft {
  x: number;
  y: number;
  r: number;
  t: string;
  c: string;
  s: number;
}

/** Oriented box around a mark, used to show and hit-test a selection. */
export interface Frame {
  /** centre */
  px: number;
  py: number;
  /** half width / height before scaling */
  hw: number;
  hh: number;
  /** base rotation */
  a0: number;
}

/** A picked-up stroke or shape and what has been done to it so far. */
export interface Selection {
  frame: Frame;
  dx: number;
  dy: number;
  /** extra rotation */
  r: number;
  /** scale */
  k: number;
  c: string;
}
