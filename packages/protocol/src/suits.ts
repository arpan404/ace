import { z } from "zod";

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
});
export type SuitManifest = z.infer<typeof SuitManifest>;

/** One failed check, phrased so an agent can fix it. */
export const SuitProblem = z.object({
  scheme: z.enum(["light", "dark"]).nullable(),
  /** e.g. "contrast", "glass-floor", "accent-fit", "schema", "asset", "scene". */
  check: z.string(),
  /** The palette field or file the problem is in, when there is one. */
  field: z.string().nullable(),
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
]);
export type SceneHostMessage = z.infer<typeof SceneHostMessage>;

/** What a scene may send back: that it is ready, that a tick's frame is drawn, or an error. */
export const SceneMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("drawn"), time: z.number() }),
  z.object({ type: z.literal("error"), message: z.string().max(500) }),
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
  /** Asset path → daemon URL, for fonts. */
  assets: z.record(z.string(), z.string()),
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

export const SuitServerMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("suitResult"),
    requestId: SuitClientMessage.shape.requestId,
    response: SuitResponse,
  }),
  /** Pushed to every signed-in socket with read scope, after the library settles. */
  z.strictObject({ type: z.literal("suitsChanged"), suits: SuitsChanged.shape.suits }),
]);
export type SuitServerMessage = z.infer<typeof SuitServerMessage>;
