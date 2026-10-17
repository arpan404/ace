import type {
  BrowserAnnotation,
  BrowserAnnotationElement,
  BrowserAnnotationEvent,
  BrowserAnnotationPageCommand,
} from "@ace/protocol";

export type { OverlayInit, OverlayPalette, OverlayTokens } from "../init.ts";

export type OverlayEvent = Exclude<BrowserAnnotationEvent, { kind: "ended" }>;
export type OverlayCommand = BrowserAnnotationPageCommand;
export type OverlayAnnotation = BrowserAnnotation;
export type OverlayElement = BrowserAnnotationElement;

/** Viewport box of an annotated element, in CSS px. */
export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The visual viewport: its offset in the document (for CDP clips), size and pixel ratio. */
export interface CaptureViewport {
  pageX: number;
  pageY: number;
  width: number;
  height: number;
  devicePixelRatio: number;
}

/** The isolated world's handle on a running overlay; the daemon calls these by expression. */
export interface OverlayHandle {
  readonly documentId: string;
  command(command: OverlayCommand): void;
  /** Hide the bar, editor and hover outline (markers stay) and wait for two frames. */
  prepareCapture(): Promise<void>;
  finishCapture(): void;
  rect(id: string): CaptureRect | null;
  viewport(): CaptureViewport;
  host(): Element;
  teardown(): void;
}
