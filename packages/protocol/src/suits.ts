import { z } from "zod";
import {
  SuitLabels,
  SuitLayout,
  SuitOrnament,
  SuitRegion,
  SuitScenes,
  SuitOrnamentSlot,
  SuitSceneRegion,
} from "./suit-parts.ts";

/*
 * Suits (ADR 0150): looks an agent makes for ace. A Suit is a folder the daemon keeps per user:
 * `suit.json` (this schema), an optional sandboxed `scene.js` and bundled `assets/`.
 *
 * A Suit sets colours, fonts, shape and motion. It never sets status colours, row status
 * colours, the approval strip, the Working line, the "waiting on you" markers or the danger fill:
 * those fields are absent here on purpose, and any extra keys are kept as raw data and ignored.
 */

export const suitFormatVersion = 1;

/** Folder name and stable id: lower-case words joined by dashes. */
export const SuitId = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type SuitId = z.infer<typeof SuitId>;

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A path inside the Suit's `assets/` folder, never outside it. */
export const SuitAssetPath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^assets\/[A-Za-z0-9._/-]+$/)
  .refine((path) => !path.split("/").includes(".."), "must stay inside assets/");

/** Built-in themes a Suit may start from (`themeIds` in @ace/themes); unset palette fields come from it. */
export const SuitBase = z.enum(["ace", "paper", "midnight", "grove", "harbor", "dusk"]);
export type SuitBase = z.infer<typeof SuitBase>;

/** The colours a Suit may set for one scheme. Every field is optional; the base fills the rest. */
export const SuitPalette = z.looseObject({
  canvas: Hex.optional(),
  sidebar: Hex.optional(),
  surface: Hex.optional(),
  raised: Hex.optional(),
  hover: Hex.optional(),
  active: Hex.optional(),
  border: Hex.optional(),
  borderStrong: Hex.optional(),
  faint: Hex.optional(),
  subtle: Hex.optional(),
  muted: Hex.optional(),
  text: Hex.optional(),
  code: Hex.optional(),
  accent: Hex.optional(),
  accentHover: Hex.optional(),
  accentFg: Hex.optional(),
  accentText: Hex.optional(),
  diffAdd: Hex.optional(),
  diffAddFg: Hex.optional(),
  diffDel: Hex.optional(),
  diffDelFg: Hex.optional(),
  syntax: z
    .looseObject({
      kw: Hex.optional(),
      fn: Hex.optional(),
      str: Hex.optional(),
      num: Hex.optional(),
      type: Hex.optional(),
      com: Hex.optional(),
      punc: Hex.optional(),
    })
    .optional(),
  /** Frosted glass over the scene; null keeps floating layers solid. */
  glass: z
    .object({
      blur: z.number().min(0).max(64),
      saturate: z.number().min(100).max(300),
    })
    .nullable()
    .optional(),
});
export type SuitPalette = z.infer<typeof SuitPalette>;

/** A font: a bundled file in `assets/`, or a system family name. No remote fonts. */
export const SuitFont = z.union([
  z.object({ asset: SuitAssetPath, family: z.string().min(1).max(80) }),
  z.object({ system: z.string().min(1).max(200) }),
]);
export type SuitFont = z.infer<typeof SuitFont>;

export const SuitManifest = z.looseObject({
  format: z.literal(suitFormatVersion),
  id: SuitId,
  name: z.string().min(1).max(60),
  description: z.string().max(280).default(""),
  /** Display only; trust binds the content hash. */
  version: z.string().max(40).default("1"),
  base: SuitBase.default("ace"),
  /** At least one scheme. A Suit with one runs only in that scheme. */
  light: SuitPalette.optional(),
  dark: SuitPalette.optional(),
  fonts: z
    .object({ ui: SuitFont.optional(), prose: SuitFont.optional(), mono: SuitFont.optional() })
    .optional(),
  shape: z
    .object({
      /** Multiplies every corner radius token. */
      radius: z.number().min(0).max(2).default(1),
      /** Hairline border weight in px. */
      border: z.number().min(0.5).max(2).default(1),
      density: z.enum(["compact", "comfortable", "spacious"]).optional(),
    })
    .optional(),
  motion: z
    .object({
      /** Multiplies the motion duration tokens. */
      speed: z.number().min(0.5).max(2).default(1),
    })
    .optional(),
  /** True when the folder has `scene.js`; set by the daemon on read, not trusted from the file. */
  scene: z.boolean().default(false),
  /** Where things sit (ADR 0150 "Layout"); each value from a fixed set. */
  layout: SuitLayout.optional(),
  /** Static, sanitised SVG or HTML placed in named slots. */
  ornaments: z.array(SuitOrnament).max(16).optional(),
  /** Short labels in fixed places; status words are never replaceable. */
  labels: SuitLabels.optional(),
  /** A scene per region; `scene.js` alone means `{ app: "scene.js" }`. */
  scenes: SuitScenes.optional(),
  /** How much of each region's scene or background shows through its surface, 0–1. */
  reveal: z.partialRecord(SuitRegion, z.number().min(0).max(1)).optional(),
});
export type SuitManifest = z.infer<typeof SuitManifest>;

/** One failed check, phrased so an agent can fix it. */
export const SuitProblem = z.object({
  scheme: z.enum(["light", "dark"]).nullable(),
  /**
   * e.g. "contrast", "glass-floor", "accent-fit", "schema", "asset", "scene", "css" (a refused
   * rule in suit.css), "ornament", and the live checks "live-contrast", "protected", "overflow".
   */
  check: z.string(),
  /** The palette field, file or part the problem is in, when there is one. */
  field: z.string().nullable(),
  /** 1-based line in the file named by `field`, for suit.css and ornaments. */
  line: z.number().int().positive().optional(),
  message: z.string(),
});
export type SuitProblem = z.infer<typeof SuitProblem>;

export const SuitSummary = z.object({
  id: SuitId,
  name: z.string(),
  description: z.string(),
  schemes: z.array(z.enum(["light", "dark"])),
  scene: z.boolean(),
  /** sha256 over the folder's sorted files; changes whenever any byte does. */
  contentHash: z.string(),
  /** Empty when the Suit passes every check and can be applied. */
  problems: z.array(SuitProblem),
});
export type SuitSummary = z.infer<typeof SuitSummary>;

/*
 * Scene messages. A scene runs in a sandboxed, opaque-origin iframe and hears only these. It
 * never receives thread contents, names or paths.
 */
export const SceneSignal = z.enum(["working", "waiting", "done", "failed", "pr-merged"]);
export type SceneSignal = z.infer<typeof SceneSignal>;

export const SceneHostMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init"),
    scheme: z.enum(["light", "dark"]),
    width: z.number(),
    height: z.number(),
    pixelRatio: z.number(),
    reduceMotion: z.boolean(),
  }),
  z.object({
    type: z.literal("resize"),
    width: z.number(),
    height: z.number(),
    pixelRatio: z.number(),
  }),
  z.object({ type: z.literal("scheme"), scheme: z.enum(["light", "dark"]) }),
  z.object({ type: z.literal("motion"), reduceMotion: z.boolean() }),
  /** The host owns the clock: one tick per frame it wants drawn, at most 30 per second. */
  z.object({ type: z.literal("tick"), time: z.number() }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("signal"), signal: SceneSignal }),
  /**
   * Asks for the canvas as it is now, averaged down to a `columns` × `rows` grid, for the live
   * contrast check. The scene draws nothing extra; the runtime answers with `sample`.
   */
  z.object({
    type: z.literal("sample"),
    id: z.number().int().nonnegative(),
    columns: z.number().int().min(1).max(32),
    rows: z.number().int().min(1).max(32),
  }),
]);
export type SceneHostMessage = z.infer<typeof SceneHostMessage>;

/** What a scene may send back: that it is ready, that a tick's frame is drawn, or an error. */
export const SceneMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("drawn"), time: z.number() }),
  z.object({ type: z.literal("error"), message: z.string().max(500) }),
  /** The answer to a host `sample`: RGBA bytes, row by row, `columns × rows × 4` of them. */
  z.object({
    type: z.literal("sample"),
    id: z.number().int().nonnegative(),
    columns: z.number().int().min(1).max(32),
    rows: z.number().int().min(1).max(32),
    pixels: z.array(z.number().int().min(0).max(255)).max(32 * 32 * 4),
  }),
]);
export type SceneMessage = z.infer<typeof SceneMessage>;

/* Requests over the daemon socket. */
export const SuitRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list") }),
  z.object({ op: z.literal("read"), id: SuitId }),
  /** Re-run every check on the folder as it is on disk now. */
  z.object({ op: z.literal("validate"), id: SuitId }),
  z.object({ op: z.literal("remove"), id: SuitId }),
]);
export type SuitRequest = z.infer<typeof SuitRequest>;

/** A Suit ready to apply: the manifest plus the scene and assets as served URLs. */
export const SuitDetail = z.object({
  summary: SuitSummary,
  manifest: SuitManifest,
  /** Daemon URL of `scene.js`'s sandbox page, or null without a scene. */
  sceneUrl: z.string().nullable(),
  /** The sandbox page per region with a scene; `app` matches `sceneUrl`. */
  sceneUrls: z.partialRecord(SuitSceneRegion, z.string()).default({}),
  /** Asset path → daemon URL, for fonts and images. */
  assets: z.record(z.string(), z.string()),
  /**
   * suit.css after the daemon's sanitiser: only `[data-part]` selectors, scoped to
   * `[data-suit="<id>"]`, asset URLs rewritten to `assets`. Null without suit.css. Clients wrap it
   * in `@layer suit` and never apply the raw file.
   */
  css: z.string().nullable().default(null),
  /** Sanitised ornament markup by slot, ready to insert. */
  ornaments: z.partialRecord(SuitOrnamentSlot, z.string()).default({}),
});
export type SuitDetail = z.infer<typeof SuitDetail>;

/** Pushed to every client when the library changes. */
export const SuitsChanged = z.object({ suits: z.array(SuitSummary) });
export type SuitsChanged = z.infer<typeof SuitsChanged>;

/** What the daemon answers a `SuitRequest` with; `op` names the request it answers. */
export const SuitResponse = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list"), suits: z.array(SuitSummary) }),
  z.object({ op: z.literal("read"), suit: SuitDetail }),
  z.object({ op: z.literal("validate"), summary: SuitSummary }),
  z.object({ op: z.literal("remove"), removed: z.boolean() }),
  z.object({
    op: z.literal("error"),
    /** `invalid`: the Suit exists but its `suit.json` doesn't parse; `summary` says why. */
    code: z.enum(["not_found", "invalid", "forbidden", "unavailable", "failed"]),
    message: z.string().max(2000),
    summary: SuitSummary.optional(),
  }),
]);
export type SuitResponse = z.infer<typeof SuitResponse>;

/* Socket frames, a message family of their own like plugins' (ADR 0014). */
export const SuitClientMessage = z.strictObject({
  type: z.literal("suitRequest"),
  requestId: z.string().min(1).max(80),
  request: SuitRequest,
});
export type SuitClientMessage = z.infer<typeof SuitClientMessage>;

/** Names one keep, so its undo puts back what each device had before it. */
export const SuitKeepId = z.string().min(1).max(80);

/**
 * What an agent's `suit_apply` asks of this device (ADR 0150). The setting (`appearance.suit`)
 * lives on each device, so the daemon never stores it: it tells the devices that saw a preview
 * what to show, and each device keeps its own undo.
 *
 * - `preview`: show `suitId` over the device's setting, without storing it.
 * - `none`: no preview; the device's own setting shows. Sent on every new socket too, so a
 *   preview never outlives the daemon run or the socket that showed it.
 * - `keep`: the device's setting becomes `suitId` and any preview ends; remember what it was
 *   under `keepId`.
 * - `restore`: undo `keepId`: put back what the device had before it, if the setting is still
 *   the Suit that keep stored.
 */
export const SuitActive = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preview"), suitId: SuitId }),
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("keep"), suitId: SuitId, keepId: SuitKeepId }),
  z.strictObject({ kind: z.literal("restore"), keepId: SuitKeepId }),
]);
export type SuitActive = z.infer<typeof SuitActive>;

/*
 * The live check (ADR 0150, "Shown perfectly"). After an agent's preview or keep, the daemon
 * asks the devices showing it to check the Suit as rendered (`suitCheck`); each answers once
 * with a `suitReport`. The daemon waits a bounded time and falls back to the static checks.
 */
export const SuitCheckId = z.string().min(1).max(80);

export const SuitLiveCheck = z.strictObject({ checkId: SuitCheckId, suitId: SuitId });
export type SuitLiveCheck = z.infer<typeof SuitLiveCheck>;

/** Kept under the socket's 1 MiB frame with room for the problems. */
export const maxSuitScreenshotChars = 900_000;

export const SuitScreenshot = z.strictObject({
  mimeType: z.enum(["image/png", "image/jpeg"]),
  /** Base64, no data: prefix. */
  data: z.string().min(1).max(maxSuitScreenshotChars),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type SuitScreenshot = z.infer<typeof SuitScreenshot>;

export const SuitLiveReport = z.strictObject({
  checkId: SuitCheckId,
  suitId: SuitId,
  /** Which client ran it: the desktop app can capture its window, a browser tab can't. */
  client: z.enum(["desktop", "web"]),
  scheme: z.enum(["light", "dark"]),
  /** Window widths in CSS px the layout was measured at; narrower ones are simulated. */
  widths: z.array(z.number().int().positive()).max(8),
  /** `live-contrast`, `protected` and `overflow` problems; `field` is the part's name. */
  problems: z.array(SuitProblem).max(200),
  /** Parts whose background is an image the check can't read, so their contrast wasn't checked. */
  unchecked: z.array(z.string().max(80)).max(100),
  screenshot: SuitScreenshot.nullable(),
  /** Why there is no screenshot, when there isn't one. */
  screenshotNote: z.string().max(300).optional(),
});
export type SuitLiveReport = z.infer<typeof SuitLiveReport>;

/** A device's answer to `suitCheck`. One-way: the daemon never replies. */
export const SuitReportMessage = z.strictObject({
  type: z.literal("suitReport"),
  report: SuitLiveReport,
});
export type SuitReportMessage = z.infer<typeof SuitReportMessage>;

export const SuitServerMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("suitResult"),
    requestId: SuitClientMessage.shape.requestId,
    response: SuitResponse,
  }),
  /** Pushed to every signed-in socket with read scope, after the library settles. */
  z.strictObject({ type: z.literal("suitsChanged"), suits: SuitsChanged.shape.suits }),
  /** Pushed to the devices an agent's preview, keep or revert is for (`SuitActive`). */
  z.strictObject({ type: z.literal("suitActive"), active: SuitActive }),
  /** Asks a device that shows `suitId` to run the live check and answer with `suitReport`. */
  z.strictObject({ type: z.literal("suitCheck"), check: SuitLiveCheck }),
]);
export type SuitServerMessage = z.infer<typeof SuitServerMessage>;
