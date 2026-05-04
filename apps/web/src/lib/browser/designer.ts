import * as Schema from "effect/Schema";

import { resolveScopedBrowserStorageKey } from "./storage";

export const BROWSER_DESIGNER_STATE_STORAGE_KEY = "ace:browser:designer:v1";

export const BrowserDesignerToolSchema = Schema.Literals(["area-comment", "element-comment"]);
export type BrowserDesignerTool = typeof BrowserDesignerToolSchema.Type;

export const BrowserDesignerPillPositionSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});
export type BrowserDesignerPillPosition = typeof BrowserDesignerPillPositionSchema.Type;

export const BrowserDesignerStateSchema = Schema.Struct({
  active: Schema.Boolean,
  pillPosition: Schema.NullOr(BrowserDesignerPillPositionSchema),
  tool: BrowserDesignerToolSchema,
});
export type BrowserDesignerState = typeof BrowserDesignerStateSchema.Type;

export function createBrowserDesignerState(): BrowserDesignerState {
  return {
    active: false,
    pillPosition: null,
    tool: "element-comment",
  };
}

export function resolveBrowserDesignerStateStorageKey(scopeId: string | null | undefined): string {
  return resolveScopedBrowserStorageKey(BROWSER_DESIGNER_STATE_STORAGE_KEY, scopeId);
}
