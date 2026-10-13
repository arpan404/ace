/*
 * The app's separator vocabulary, all drawn on `--border`, so every hairline reads the same in
 * light and dark. Pick by job:
 *
 * - `toolbarEdge`: the bottom edge of a tab strip or a panel toolbar. A box-shadow, not a
 *   border, so the strip's controls stay on its exact centre line.
 * - `sectionRule`: the top rule of a section that follows another (Summary's Background and
 *   Automations, a card's footer).
 * - `listDivider`: hairlines between the rows of one list or card.
 * - `controlDivider`: a short vertical rule between two control groups in a toolbar.
 *
 * Sidebar thread rows never take a rule: they separate by their hover and selected fills.
 */
export const toolbarEdge = "shadow-[inset_0_-1px_0_var(--border)]";
export const sectionRule = "border-t border-border";
export const listDivider = "divide-y divide-border-soft";
export const controlDivider = "mx-1 h-4 w-px shrink-0 bg-border";

/*
 * Containers, two and only two:
 *
 * - `groupCard`: grouped, settings-like content (Settings, a skill's details, an automation's
 *   When / Runs on / Recent runs). Rows inside take `listDivider`.
 * - `rowCard`: one outlined row of a side-panel list (Summary's agents, background commands and
 *   automations). Each row is its own card; rows stack with a small gap.
 *
 * Everything else (the transcript, the sidebar, menus) is borderless.
 */
export const groupCard = "rounded-lg border border-border-soft bg-card";
export const rowCard =
  "rounded-md border border-border bg-surface-1 transition-colors duration-(--motion-fast) hover:bg-accent";
