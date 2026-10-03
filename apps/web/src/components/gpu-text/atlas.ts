import type { GlyphRect } from "./layout.ts";

/*
 * Glyphs rasterised once into a canvas the GPU samples as a texture: white ink on transparent,
 * tinted per quad. Glyphs are added as they first appear; a full atlas starts over (the view
 * then redraws), so memory stays fixed.
 */

const size = 2048;

export class GlyphAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** CSS px per glyph cell; device pixels are this times `scale`. */
  readonly scale: number;
  /** Bumps when glyphs were added, so backends re-upload the texture. */
  version = 0;
  /** Bumps when the atlas starts over; rects handed out earlier are then stale. */
  generation = 0;
  readonly solid: GlyphRect;
  private context: CanvasRenderingContext2D;
  private slots = new Map<string, GlyphRect>();
  private next = 1;
  private font: string;
  constructor(options: {
    fontPx: number;
    family: string;
    cellWidth: number;
    lineHeight: number;
    scale: number;
  }) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = size;
    this.canvas.height = size;
    const context = this.canvas.getContext("2d", { willReadFrequently: false });
    if (!context) throw new Error("No 2D canvas for the glyph atlas");
    this.context = context;
    this.scale = options.scale;
    this.cellWidth = Math.ceil(options.cellWidth * options.scale);
    this.cellHeight = Math.ceil(options.lineHeight * options.scale);
    this.font = `${options.fontPx * options.scale}px ${options.family}`;
    this.solid = this.rect(0);
    this.reset();
  }
  private get perRow(): number {
    return Math.floor(size / this.cellWidth);
  }
  private rect(slot: number): GlyphRect {
    const x = (slot % this.perRow) * this.cellWidth;
    const y = Math.floor(slot / this.perRow) * this.cellHeight;
    return {
      u0: x / size,
      v0: y / size,
      u1: (x + this.cellWidth) / size,
      v1: (y + this.cellHeight) / size,
    };
  }
  private reset(): void {
    const context = this.context;
    context.clearRect(0, 0, size, size);
    context.fillStyle = "#fff";
    // Slot 0 is solid, for line bands.
    context.fillRect(0, 0, this.cellWidth, this.cellHeight);
    context.font = this.font;
    context.textBaseline = "middle";
    this.slots.clear();
    this.next = 1;
    this.version++;
    this.generation++;
  }
  glyph(char: string): GlyphRect | undefined {
    if (char === " ") return undefined;
    const known = this.slots.get(char);
    if (known) return known;
    const capacity = this.perRow * Math.floor(size / this.cellHeight);
    if (this.next >= capacity) this.reset();
    const slot = this.next++;
    const rect = this.rect(slot);
    const x = (slot % this.perRow) * this.cellWidth;
    const y = Math.floor(slot / this.perRow) * this.cellHeight;
    this.context.fillText(char, x, y + this.cellHeight / 2);
    this.slots.set(char, rect);
    this.version++;
    return rect;
  }
}
