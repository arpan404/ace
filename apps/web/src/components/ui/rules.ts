/*
 * The app's separator vocabulary, all drawn on `--border`, so every hairline reads the same in
 * light and dark. Pick by job:
 *
 * - `toolbarEdge`: the bottom edge of a tab strip or a panel toolbar. A box-shadow, not a
 *   border, so the strip's controls stay on its exact centre line.
 * - `sectionRule`: the top rule of a section that follows another (a card's footer). Side
 *   panels never take one: their sections part by spacing and a small muted label.
 * - `listDivider`: hairlines between the rows of one list or card.
 * - `controlDivider`: a short vertical rule between two control groups in a toolbar.
 * - `boundaryMarker`: a short vertical rule in the top bar where two of the app's parts meet
 *   (sidebar and column, column and side panel), on the edge the canvas's hairline runs down.
 *
 * Sidebar thread rows never take a rule: they separate by their hover and selected fills.
 */
export const toolbarEdge = "shadow-[inset_0_-1px_0_var(--border)]";
export const sectionRule = "border-t border-border";
export const listDivider = "divide-y divide-border-soft";
/**
 * Placed at the left edge of the part that starts there (its parent positioned), 20px tall and
 * centred. It never takes a pointer, so the bar still drags the window under it.
 */
export const boundaryMarker =
  "pointer-events-none absolute top-1/2 left-0 h-5 w-px -translate-y-1/2 bg-border";
export const controlDivider = "mx-1 h-4 w-px shrink-0 bg-border";
/** `controlDivider` turned on its side, between the groups of a vertical rail of controls. */
export const railDivider = "my-1 h-px w-4 shrink-0 bg-border";

/*
 * Over a Suit's scene (ADR 0150) the canvas lets the scene through. A page that paints its own
 * colour over the canvas would hide it, so:
 *
 * - `sceneThrough`: a page's own full-size fill steps aside while a scene shows.
 * - `sceneBar`: a bar that sticks over scrolling content is tinted and blurred instead of solid,
 *   so rows still pass under it unread and the scene still shows beside them. Under Solid
 *   surfaces or reduced transparency nothing blurs, so the bar stays solid there.
 */
export const sceneThrough = "[[data-suit-scene]_&]:bg-transparent";
export const sceneBar =
  "[[data-surface=translucent]_[data-suit-scene]_&]:bg-[color:color-mix(in_oklab,var(--panel)_72%,transparent)] [[data-surface=translucent]_[data-suit-scene]_&]:backdrop-blur-md";
/**
 * `panelReveal`: a side panel's colour over the scene (the thread's side and bottom panels, a
 * Spade bot's or group's profile). `--suit-right-panel-reveal` of the scene shows through (the
 * Suit's `reveal["right-panel"]`, held to what keeps the panel's text readable;
 * theme/suits/suit-layers.ts). Solid without a scene, and by default.
 */
export const panelReveal =
  "[[data-suit-scene]_&]:bg-[color:color-mix(in_oklab,var(--panel)_calc(100%_-_var(--suit-right-panel-reveal,0)*100%),transparent)]";

/*
 * Containers:
 *
 * - `groupCard`: grouped, settings-like content (Settings, a skill's details, an automation's
 *   When / Runs on / Recent runs). Rows inside take `listDivider`.
 * - `plainRow`: one borderless row of a side-panel list (Summary's agents, background commands
 *   and automations), as sidebar rows are: a rounded hover fill and nothing at rest.
 *
 * Everything else (the transcript, the sidebar, menus) is borderless.
 */
export const groupCard = "rounded-lg border border-border-soft bg-card";
/*
 * `cardEdge`: the hairline edge of an inline transcript card (a code block, a task card, an
 * answered question, a started-thread card, a command preview). An inset shadow rather than a
 * border so the card's content box keeps its padding exact.
 */
export const cardEdge = "shadow-[inset_0_0_0_1px_var(--border)]";
export const plainRow = "rounded-md transition-colors duration-(--motion-fast) hover:bg-accent";
/*
 * `rowCard`: one outlined row of a side-panel list that asks for action (the PR panel's Needs
 * attention): a hairline edge, a hover wash.
 * `hairlineGrid`: cells separated by 1px hairlines in the border colour (the PR merge gates);
 * each cell paints its own surface over the grid's.
 */
export const rowCard = `rounded-md ${cardEdge} transition-colors duration-(--motion-fast) hover:bg-hover`;
export const hairlineGrid = "grid gap-px bg-border";
