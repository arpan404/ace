import type { ThreadId } from "@ace/contracts";
import * as Schema from "effect/Schema";

import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import { resolveScopedBrowserStorageKey } from "./browser/storage";

export const BROWSER_PANEL_MODE_STORAGE_KEY = "ace:chat:browser-panel-mode:v2";
export const RIGHT_SIDE_PANEL_MODE_STORAGE_KEY = "ace:chat:right-side-panel-mode:v1";
export const RIGHT_SIDE_PANEL_LAST_NON_DIFF_MODE_STORAGE_KEY =
  "ace:chat:right-side-panel-last-non-diff-mode:v1";
export const RIGHT_SIDE_PANEL_REVIEW_OPEN_STORAGE_KEY = "ace:chat:right-side-panel-review-open:v1";
export const RIGHT_SIDE_PANEL_EDITOR_OPEN_STORAGE_KEY = "ace:chat:right-side-panel-editor-open:v1";
export const RIGHT_SIDE_PANEL_FULLSCREEN_STORAGE_KEY = "ace:chat:right-side-panel-fullscreen:v1";
export const RIGHT_SIDE_PANEL_DIFF_OPEN_STORAGE_KEY = "ace:chat:right-side-panel-diff-open:v1";
export const RIGHT_SIDE_PANEL_VISIBLE_STORAGE_KEY = "ace:chat:right-side-panel-visible:v1";
export const RIGHT_SIDE_PANEL_WIDTH_STORAGE_KEY = "ace:chat:right-side-panel-width:v1";

export type RightSidePanelMode = "browser" | "diff" | "editor" | "simulator" | "summary";

export const RightSidePanelModeStorageSchema = Schema.NullOr(
  Schema.Literals(["browser", "diff", "editor", "simulator", "summary"]),
);

export function resolveThreadRightSidePanelStorageKeys(threadId: ThreadId): {
  browserMode: string;
  diffOpen: string;
  editorOpen: string;
  fullscreen: string;
  lastNonDiffMode: string;
  mode: string;
  reviewOpen: string;
  visible: string;
} {
  return {
    browserMode: resolveScopedBrowserStorageKey(BROWSER_PANEL_MODE_STORAGE_KEY, threadId),
    diffOpen: resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_DIFF_OPEN_STORAGE_KEY, threadId),
    editorOpen: resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_EDITOR_OPEN_STORAGE_KEY, threadId),
    fullscreen: resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_FULLSCREEN_STORAGE_KEY, threadId),
    lastNonDiffMode: resolveScopedBrowserStorageKey(
      RIGHT_SIDE_PANEL_LAST_NON_DIFF_MODE_STORAGE_KEY,
      threadId,
    ),
    mode: resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_MODE_STORAGE_KEY, threadId),
    reviewOpen: resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_REVIEW_OPEN_STORAGE_KEY, threadId),
    visible: resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_VISIBLE_STORAGE_KEY, threadId),
  };
}

export function resetThreadRightSidePanelState(threadId: ThreadId): void {
  const keys = resolveThreadRightSidePanelStorageKeys(threadId);
  removeLocalStorageItem(keys.browserMode);
  removeLocalStorageItem(keys.diffOpen);
  removeLocalStorageItem(keys.editorOpen);
  removeLocalStorageItem(keys.fullscreen);
  removeLocalStorageItem(keys.lastNonDiffMode);
  removeLocalStorageItem(keys.mode);
  removeLocalStorageItem(keys.reviewOpen);
  removeLocalStorageItem(keys.visible);
}

export function resolveRightSidePanelModeAfterDiffClose(input: {
  activeMode: RightSidePanelMode | null;
  lastNonDiffMode: RightSidePanelMode | null;
}): RightSidePanelMode {
  if (input.activeMode && input.activeMode !== "diff") {
    return input.activeMode;
  }
  if (input.lastNonDiffMode && input.lastNonDiffMode !== "diff") {
    return input.lastNonDiffMode;
  }
  return "summary";
}
