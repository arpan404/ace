import { z } from "zod";
import { ThreadId } from "./ids.ts";

/**
 * Browser annotation (ADR 0082): the person pins numbered comments on elements of the page in
 * ace's Browser. The overlay runs inside the page; the daemon relays its events to the one
 * connection that started it. Records are page data and are decoded leniently: unknown fields
 * are kept, unknown event kinds are delivered as raw objects.
 */
export const browserAnnotationLimit = 20;
/** Largest base64 image a capture returns, matching the desktop relay's frame bound. */
export const browserAnnotationCaptureLimit = 768 * 1024;

const id = z.string().min(1).max(256);
const finite = z.number().finite();
const fraction = z.number().finite().min(0).max(1);

export const BrowserAnnotationBox = z.object({
  x: finite,
  y: finite,
  width: finite.nonnegative(),
  height: finite.nonnegative(),
});
export type BrowserAnnotationBox = z.infer<typeof BrowserAnnotationBox>;

/** The annotated element as the page showed it. `box` is in CSS px from the document's top-left. */
export const BrowserAnnotationElement = z.looseObject({
  tag: z.string().min(1).max(64),
  selector: z.string().max(2048),
  xpath: z.string().max(2048),
  text: z.string().max(280),
  role: z.string().max(128).optional(),
  name: z.string().max(256).optional(),
  box: BrowserAnnotationBox,
  /** Frame URL when the element is not in the top document. */
  frame: z.string().max(8192).optional(),
});
export type BrowserAnnotationElement = z.infer<typeof BrowserAnnotationElement>;

/** A previewed style edit: computed values before and after. */
export const BrowserAnnotationStyleChange = z.looseObject({
  property: z.string().min(1).max(64),
  before: z.string().max(256),
  after: z.string().max(256),
});
export type BrowserAnnotationStyleChange = z.infer<typeof BrowserAnnotationStyleChange>;

export const BrowserAnnotationTextChange = z.looseObject({
  before: z.string().max(4000),
  after: z.string().max(4000),
});
export type BrowserAnnotationTextChange = z.infer<typeof BrowserAnnotationTextChange>;

export const BrowserAnnotationViewport = z.object({
  width: finite.nonnegative(),
  height: finite.nonnegative(),
  devicePixelRatio: finite.positive(),
  scrollX: finite,
  scrollY: finite,
});
export type BrowserAnnotationViewport = z.infer<typeof BrowserAnnotationViewport>;

/** What the person marked: one element they clicked, or an area they dragged out. */
export const BrowserAnnotationKind = z.enum(["element", "region"]);
export type BrowserAnnotationKind = z.infer<typeof BrowserAnnotationKind>;
/** Most elements a region names for the agent. */
export const browserAnnotationRegionElementLimit = 8;

/**
 * A dragged area. `box` is in CSS px from the document's top-left (the viewport box is `box`
 * less the record's `viewport` scroll). `elements` are the page elements mostly inside it,
 * outermost first in document order, at most eight.
 */
export const BrowserAnnotationRegion = z.looseObject({
  box: BrowserAnnotationBox,
  elements: z.array(BrowserAnnotationElement).max(browserAnnotationRegionElementLimit).default([]),
});
export type BrowserAnnotationRegion = z.infer<typeof BrowserAnnotationRegion>;

export const BrowserAnnotation = z.looseObject({
  id,
  number: z.number().int().min(1).max(99),
  documentId: id,
  url: z.string().max(8192),
  title: z.string().max(1024),
  /** Records written before regions existed are element annotations. */
  kind: BrowserAnnotationKind.default("element"),
  /** Where the person clicked, as a fraction of the element's box (markers sit at its corner). */
  point: z.object({ x: fraction, y: fraction }),
  comment: z.string().max(4000),
  /**
   * The clicked element; for a region, the smallest element containing the whole area, so the
   * agent knows where in the page it sits.
   */
  element: BrowserAnnotationElement,
  /** Present exactly when `kind` is `region`. */
  region: BrowserAnnotationRegion.optional(),
  styles: z.array(BrowserAnnotationStyleChange).max(24).default([]),
  text: BrowserAnnotationTextChange.optional(),
  viewport: BrowserAnnotationViewport,
  /** The browser tab the person annotated, when the client knows it. */
  tabId: id.optional(),
});
export type BrowserAnnotation = z.infer<typeof BrowserAnnotation>;

export const BrowserAnnotationEndReason = z.enum([
  "navigated",
  "lease",
  "tab",
  "restart",
  "disconnect",
  "stopped",
]);
export type BrowserAnnotationEndReason = z.infer<typeof BrowserAnnotationEndReason>;

const position = z.object({ x: finite, y: finite });

/** What the overlay (and, for `ended`, the daemon) reports to the annotating connection. */
export const BrowserAnnotationEvent = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("ready"),
    documentId: id,
    url: z.string().max(8192),
    title: z.string().max(1024),
  }),
  z.looseObject({ kind: z.literal("saved"), annotation: BrowserAnnotation }),
  z.looseObject({ kind: z.literal("removed"), id }),
  /** The person discarded every annotation from the page's bar. */
  z.looseObject({ kind: z.literal("discard") }),
  /** The person asked for a screenshot of the page with its markers. */
  z.looseObject({ kind: z.literal("screenshot") }),
  /** The person pressed Send on the page's bar. */
  z.looseObject({ kind: z.literal("send") }),
  /** The person closed annotate mode from the page; the daemon ends the session after this. */
  z.looseObject({ kind: z.literal("close") }),
  /** The bar was dragged to a new position (CSS px from the viewport's top-left). */
  z.looseObject({ kind: z.literal("bar"), ...position.shape }),
  z.looseObject({ kind: z.literal("ended"), reason: BrowserAnnotationEndReason }),
]);
export type BrowserAnnotationEvent = z.infer<typeof BrowserAnnotationEvent>;

export const BrowserAnnotationTheme = z.enum(["light", "dark"]);

/** Overlay settings sent on start and with `configure`. */
export const BrowserAnnotationConfig = z.object({
  theme: BrowserAnnotationTheme.default("dark"),
  /** Number the next new annotation receives. */
  nextNumber: z.number().int().min(1).max(99).default(1),
  markersHidden: z.boolean().optional(),
  bar: position.optional(),
});
export type BrowserAnnotationConfig = z.infer<typeof BrowserAnnotationConfig>;

/** Commands the annotating connection sends to the page's overlay. */
export const BrowserAnnotationPageCommand = z.discriminatedUnion("op", [
  BrowserAnnotationConfig.extend({ op: z.literal("configure") }),
  /** Reopen the editor of an existing annotation. */
  z.object({ op: z.literal("edit"), id }),
  z.object({ op: z.literal("remove"), id }),
  z.object({ op: z.literal("clear") }),
  z.object({
    op: z.literal("renumber"),
    numbers: z
      .array(z.object({ id, number: z.number().int().min(1).max(99) }))
      .max(browserAnnotationLimit),
  }),
  z.object({ op: z.literal("toast"), text: z.string().min(1).max(200) }),
  /** Show these annotations' markers again (for example after the renderer restarted). */
  z.object({
    op: z.literal("restore"),
    annotations: z.array(BrowserAnnotation).max(browserAnnotationLimit),
  }),
]);
export type BrowserAnnotationPageCommand = z.infer<typeof BrowserAnnotationPageCommand>;

export const BrowserAnnotationCaptureTarget = z.discriminatedUnion("kind", [
  /** The visible page with markers, without the bar or an open editor. */
  z.object({ kind: z.literal("page") }),
  /**
   * The annotated element with an 8 px margin, or a region exactly; long edge at most 1024 px.
   */
  z.object({ kind: z.literal("annotation"), id }),
]);
export type BrowserAnnotationCaptureTarget = z.infer<typeof BrowserAnnotationCaptureTarget>;

export const BrowserAnnotationCapture = z.object({
  mimeType: z.enum(["image/png", "image/jpeg"]),
  /** Base64 image bytes. */
  data: z.string().max(browserAnnotationCaptureLimit),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type BrowserAnnotationCapture = z.infer<typeof BrowserAnnotationCapture>;

/** Daemon to the annotating connection. `event` is decoded with `BrowserAnnotationEvent` by clients. */
export const BrowserAnnotationMessage = z.object({
  type: z.literal("browser.annotation"),
  threadId: ThreadId,
  event: z.looseObject({ kind: z.string().min(1).max(64) }),
});
export type BrowserAnnotationMessage = z.infer<typeof BrowserAnnotationMessage>;
