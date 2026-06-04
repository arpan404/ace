import { ThreadId } from "@ace/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  resolveRequestedRightSidePanelMode,
  resolveRightSidePanelModeAfterDiffClose,
  resolveThreadRightSidePanelStorageKeys,
  resetThreadRightSidePanelState,
  shouldApplyThreadBrowserViewportResizeToVisiblePanel,
} from "./rightSidePanelState";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../hooks/useLocalStorage";

describe("rightSidePanelState", () => {
  it("resets persisted per-thread right side panel state", () => {
    const threadId = ThreadId.makeUnsafe("thread-reset");
    const keys = resolveThreadRightSidePanelStorageKeys(threadId);

    setLocalStorageItem(keys.browserMode, "split", Schema.Literals(["closed", "full", "split"]));
    setLocalStorageItem(keys.diffOpen, true, Schema.Boolean);
    setLocalStorageItem(keys.editorOpen, true, Schema.Boolean);
    setLocalStorageItem(keys.fullscreen, true, Schema.Boolean);
    setLocalStorageItem(
      keys.lastNonDiffMode,
      "browser",
      Schema.Literals(["browser", "editor", "subagent", "summary", "terminal"]),
    );
    setLocalStorageItem(
      keys.mode,
      "diff",
      Schema.NullOr(
        Schema.Literals(["browser", "diff", "editor", "subagent", "summary", "terminal"]),
      ),
    );
    setLocalStorageItem(keys.reviewOpen, true, Schema.Boolean);
    setLocalStorageItem(keys.terminalOpen, true, Schema.Boolean);
    setLocalStorageItem(keys.visible, false, Schema.Boolean);

    resetThreadRightSidePanelState(threadId);

    expect(
      getLocalStorageItem(keys.browserMode, Schema.Literals(["closed", "full", "split"])),
    ).toBe(null);
    expect(getLocalStorageItem(keys.diffOpen, Schema.Boolean)).toBe(null);
    expect(getLocalStorageItem(keys.editorOpen, Schema.Boolean)).toBe(null);
    expect(getLocalStorageItem(keys.fullscreen, Schema.Boolean)).toBe(null);
    expect(
      getLocalStorageItem(
        keys.lastNonDiffMode,
        Schema.Literals(["browser", "editor", "subagent", "summary", "terminal"]),
      ),
    ).toBe(null);
    expect(
      getLocalStorageItem(
        keys.mode,
        Schema.NullOr(
          Schema.Literals(["browser", "diff", "editor", "subagent", "summary", "terminal"]),
        ),
      ),
    ).toBe(null);
    expect(getLocalStorageItem(keys.reviewOpen, Schema.Boolean)).toBe(null);
    expect(getLocalStorageItem(keys.terminalOpen, Schema.Boolean)).toBe(null);
    expect(getLocalStorageItem(keys.visible, Schema.Boolean)).toBe(null);

    removeLocalStorageItem(keys.browserMode);
    removeLocalStorageItem(keys.diffOpen);
    removeLocalStorageItem(keys.editorOpen);
    removeLocalStorageItem(keys.fullscreen);
    removeLocalStorageItem(keys.lastNonDiffMode);
    removeLocalStorageItem(keys.mode);
    removeLocalStorageItem(keys.reviewOpen);
    removeLocalStorageItem(keys.terminalOpen);
    removeLocalStorageItem(keys.visible);
  });

  it("falls back to the last non-diff tab when closing review", () => {
    expect(
      resolveRightSidePanelModeAfterDiffClose({
        activeMode: "browser",
        lastNonDiffMode: "summary",
      }),
    ).toBe("browser");
    expect(
      resolveRightSidePanelModeAfterDiffClose({
        activeMode: "diff",
        lastNonDiffMode: "editor",
      }),
    ).toBe("editor");
    expect(
      resolveRightSidePanelModeAfterDiffClose({
        activeMode: "diff",
        lastNonDiffMode: null,
      }),
    ).toBe("summary");
  });

  it("keeps the selected right panel tab active while review remains open", () => {
    expect(
      resolveRequestedRightSidePanelMode({
        rightSidePanelOpen: true,
        reviewOpen: true,
        selectedMode: "browser",
      }),
    ).toBe("browser");
    expect(
      resolveRequestedRightSidePanelMode({
        rightSidePanelOpen: true,
        reviewOpen: true,
        selectedMode: "editor",
      }),
    ).toBe("editor");
    expect(
      resolveRequestedRightSidePanelMode({
        rightSidePanelOpen: true,
        reviewOpen: true,
        selectedMode: null,
      }),
    ).toBe("diff");
  });

  it("resolves no active right panel mode when the panel is closed", () => {
    expect(
      resolveRequestedRightSidePanelMode({
        rightSidePanelOpen: false,
        reviewOpen: true,
        selectedMode: "diff",
      }),
    ).toBe(null);
  });

  it("applies browser viewport resize only to the visible owning thread", () => {
    const activeThreadId = ThreadId.makeUnsafe("thread-active");
    const backgroundThreadId = ThreadId.makeUnsafe("thread-background");

    expect(
      shouldApplyThreadBrowserViewportResizeToVisiblePanel({
        activeThreadId,
        requestThreadId: activeThreadId,
        rightSidePanelInteractive: true,
      }),
    ).toBe(true);

    expect(
      shouldApplyThreadBrowserViewportResizeToVisiblePanel({
        activeThreadId,
        requestThreadId: backgroundThreadId,
        rightSidePanelInteractive: true,
      }),
    ).toBe(false);

    expect(
      shouldApplyThreadBrowserViewportResizeToVisiblePanel({
        activeThreadId,
        requestThreadId: activeThreadId,
        rightSidePanelInteractive: false,
      }),
    ).toBe(false);
  });
});
