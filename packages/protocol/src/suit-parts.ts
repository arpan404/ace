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
  "nav-item",
  "terminal",
  "file-tree",
  "browser-panel",
  "empty-state",
  "scrollbar",
  "divider",
  // Every full page (PRs, issues, inbox, automations, skills, usage, Spade, settings, setup,
  // sign-in, connect, …) is built from these, with `data-page` on its `page` naming which.
  "page",
  "page-header",
  "page-title",
  "page-toolbar",
  "page-body",
  "page-section",
  "list",
  "list-row",
  "list-group",
  "card",
  "table",
  "table-row",
  "stat",
  "filter-bar",
  "search-field",
  "avatar",
  "label-chip",
  "progress",
  "chart",
  // Side panels: every tab's content (git, files, terminal, browser, preview, notes, …)
  "panel-body",
  "terminal-tab",
  "panel-toolbar",
  "panel-tab",
  // Pull requests, issues and code review
  "pr-header",
  "pr-row",
  "issue-row",
  "review-comment",
  "review-thread",
  "check-row",
  "commit-row",
  "diff-file",
  "diff-line",
  "timeline-item",
  "branch-chip",
  "merge-box",
  // Spade and chats
  "spade-message",
  "chat-row",
  // Added 2026-11-15 (platform upgrade)
  "segmented",
  "segment",
  "segmented-thumb",
  "switch-thumb",
  "slider-thumb",
  "tool-group-header",
  "tool-icon",
  "composer-strip",
  "queue-strip",
  "queue-item",
  // Added 2026-11-16 (the Marketplace modal)
  "market-stage",
  "market-hero",
  "market-try",
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

/**
 * Pages, as `data-page` on the `page` part (and on `app` for the page on screen), so a Suit can
 * style one page apart from the rest: `[data-page=pulls] [data-part=list-row]`.
 */
export const suitPages = [
  "thread",
  "new-thread",
  "chats",
  "chat",
  "pulls",
  "pull",
  "issues",
  "issue",
  "inbox",
  "review",
  "automations",
  "automation",
  "skills",
  "skill",
  "marketplace",
  "market-entry",
  "usage",
  "spade",
  "history",
  "settings",
  "sign-in",
  "setup",
  "connect",
] as const;
export const SuitPage = z.enum(suitPages);
export type SuitPage = z.infer<typeof SuitPage>;

/** Regions that read `--suit-<part>-background` and may host their own scene. */
export const suitRegions = [
  "app",
  "rail",
  "sidebar",
  "header",
  "transcript",
  "composer",
  "right-panel",
  "page",
] as const;
export const SuitRegion = z.enum(suitRegions);
export type SuitRegion = z.infer<typeof SuitRegion>;

/**
 * Regions a scene may run in. `celebration` is special: a full-window layer ABOVE the UI that
 * ace mounts only for a moment after `done` or `pr-merged` (at most 4 s, pointer-events none,
 * never over approvals or the Working line, skipped under reduce motion). Its scene gets the
 * signal that woke it, plays once and fades; the host unmounts it.
 */
export const SuitSceneRegion = z.enum([
  "app",
  "celebration",
  "sidebar",
  "header",
  "composer",
  "right-panel",
  "page",
]);
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
    .refine((path) => !path.split("/").includes(".."))
    .meta({ "x-ace-constraint": "No `..` path segment: the path stays inside assets/." }),
});
export type SuitOrnament = z.infer<typeof SuitOrnament>;

/** A scene file per region: `scene.js` or another `.js` file at the Suit's root. */
export const SuitScenes = z.partialRecord(SuitSceneRegion, z.string().regex(/^[A-Za-z0-9-]+\.js$/));
export type SuitScenes = z.infer<typeof SuitScenes>;

export const SuitLabels = z.partialRecord(SuitLabelKey, z.string().min(1).max(40));
export type SuitLabels = z.infer<typeof SuitLabels>;

const TerminalHex = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const ansiNames = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/**
 * The terminal draws on a canvas, so CSS can't reach its text. A Suit sets it here, per scheme;
 * anything unset is derived from the Suit's palette as for a built-in theme. ANSI colours are
 * fitted to stay readable on the background, as the theme's are.
 */
export const SuitTerminalColours = z.object({
  background: TerminalHex.optional(),
  foreground: TerminalHex.optional(),
  cursor: TerminalHex.optional(),
  cursorAccent: TerminalHex.optional(),
  selection: TerminalHex.optional(),
  ansi: z.partialRecord(z.enum(ansiNames), TerminalHex).optional(),
});
export type SuitTerminalColours = z.infer<typeof SuitTerminalColours>;

export const SuitTerminal = z.object({
  light: SuitTerminalColours.optional(),
  dark: SuitTerminalColours.optional(),
  /** A system family or a bundled font's family from `fonts`. */
  fontFamily: z.string().min(1).max(200).optional(),
  fontSize: z.number().min(9).max(24).optional(),
  lineHeight: z.number().min(1).max(2).optional(),
  letterSpacing: z.number().min(-1).max(4).optional(),
  cursorStyle: z.enum(["block", "bar", "underline"]).optional(),
  cursorBlink: z.boolean().optional(),
  /** How much of the terminal region's background or scene shows behind the text, 0–1. */
  reveal: z.number().min(0).max(1).optional(),
});
export type SuitTerminal = z.infer<typeof SuitTerminal>;
