/*
 * The editor's pure model: groups in a split tree, tab rules, drop targets, the stored layout and
 * its migration from per-file panel tabs. No I/O; ids are injected. Spec: docs/editor/workbench.md.
 */
export * from "./types.ts";
export * from "./tree.ts";
export * from "./tabs.ts";
export * from "./close.ts";
export * from "./drag.ts";
export * from "./schema.ts";
export * from "./migrate.ts";
