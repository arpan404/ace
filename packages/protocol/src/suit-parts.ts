import { z } from "zod";

/*
 * The styling contract for Suits (ADR 0150, "Full customisation"). Every name here is a
 * `data-part` the app renders; `suit.css` may only select these, plus `data-state`,
 * `data-variant` and `data-scheme`. Parts are public API: renaming or removing one needs an alias
 * for a release and a note in docs/design/suit-parts.md.
 */

export const suitPartsVersion = 1;

export const suitParts = [
  // Window and regions
  "app",
  "rail",
  "rail-item",
  "sidebar",
  "sidebar-header",
  "sidebar-footer",
  "sidebar-tabs",
  "thread-list",
  "thread-row",
  "thread-title",
  "thread-meta",
  "project-header",
  "header",
  "header-title",
  "main",
  "transcript",
  "right-panel",
  "panel-header",
  // Transcript
  "message-user",
  "message-agent",
  "message-meta",
  "turn-divider",
  "tool-row",
  "tool-output",
  "code-block",
  "inline-code",
  "diff",
  "link",
  "attachment",
  // Agent state (protected: see `protectedSuitParts`)
  "working-line",
  "approval-strip",
  "question-card",
  "status-icon",
  // Composer
  "composer",
  "composer-input",
  "composer-toolbar",
  "composer-send",
  "model-picker",
  // Controls
  "button",
  "icon-button",
  "input",
  "select",
  "checkbox",
  "switch",
  "slider",
  "tabs",
  "tab",
  "badge",
  "kbd",
  // Floating layers
  "menu",
  "menu-item",
  "popover",
  "dialog",
  "tooltip",
  "toast",
  "command-palette",
  // Pages and panels
  "settings-nav",
  "settings-section",
  "settings-row",
  "terminal",
  "file-tree",
  "browser-panel",
  "empty-state",
  "scrollbar",
  "divider",
] as const;
export const SuitPart = z.enum(suitParts);
export type SuitPart = z.infer<typeof SuitPart>;

/**
 * Parts that show the state of an agent. ace's guard layer keeps them visible, readable and in
 * ace's colours whatever a Suit's CSS says; a Suit may still frame them (spacing, radius, font).
 */
export const protectedSuitParts = [
  "working-line",
  "approval-strip",
  "question-card",
  "status-icon",
] as const satisfies readonly SuitPart[];

/** States a part may carry in `data-state`. */
export const suitPartStates = [
  "active",
  "selected",
  "open",
  "closed",
  "disabled",
  "checked",
  "hover",
  "working",
  "waiting",
  "done",
  "failed",
  "unread",
] as const;

/** Regions that read `--suit-<part>-background` and may host their own scene. */
export const suitRegions = ["app", "rail", "sidebar", "header", "transcript", "composer"] as const;
export const SuitRegion = z.enum(suitRegions);
export type SuitRegion = z.infer<typeof SuitRegion>;

/** Regions a scene may run in. */
export const SuitSceneRegion = z.enum(["app", "sidebar", "header", "composer"]);
export type SuitSceneRegion = z.infer<typeof SuitSceneRegion>;

/** Where an ornament (static, sanitised SVG or HTML) may be placed. */
export const SuitOrnamentSlot = z.enum([
  "sidebar-header",
  "sidebar-footer",
  "transcript-top",
  "empty-state",
  "composer-top",
  "corner-top-left",
  "corner-top-right",
  "corner-bottom-left",
  "corner-bottom-right",
]);
export type SuitOrnamentSlot = z.infer<typeof SuitOrnamentSlot>;

/** Short labels a Suit may replace. Status words are never in this list. */
export const SuitLabelKey = z.enum([
  "composer-placeholder",
  "empty-transcript",
  "empty-sidebar",
  "working-word",
  "send",
]);
export type SuitLabelKey = z.infer<typeof SuitLabelKey>;

export const SuitLayout = z.object({
  sidebar: z.enum(["left", "right"]).default("left"),
  rail: z.enum(["shown", "hidden", "merged"]).default("shown"),
  /** px */
  sidebarWidth: z.number().int().min(200).max(480).optional(),
  /** px, the reading column's max width */
  transcriptWidth: z.number().int().min(560).max(1400).optional(),
  composer: z.enum(["docked", "floating"]).default("docked"),
  header: z.enum(["bar", "minimal", "hidden"]).default("bar"),
  messages: z.enum(["bubbles", "flat", "cards"]).default("bubbles"),
  toolRows: z.enum(["compact", "detailed", "terminal"]).default("compact"),
});
export type SuitLayout = z.infer<typeof SuitLayout>;

export const SuitOrnament = z.object({
  slot: SuitOrnamentSlot,
  /** A file in the Suit's `assets/`: `.svg` or `.html`, sanitised before use. */
  asset: z
    .string()
    .regex(/^assets\/[A-Za-z0-9._/-]+\.(svg|html)$/)
    .refine((path) => !path.split("/").includes("..")),
});
export type SuitOrnament = z.infer<typeof SuitOrnament>;

/** A scene file per region: `scene.js` or another `.js` file at the Suit's root. */
export const SuitScenes = z.partialRecord(SuitSceneRegion, z.string().regex(/^[A-Za-z0-9-]+\.js$/));
export type SuitScenes = z.infer<typeof SuitScenes>;

export const SuitLabels = z.partialRecord(SuitLabelKey, z.string().min(1).max(40));
export type SuitLabels = z.infer<typeof SuitLabels>;
