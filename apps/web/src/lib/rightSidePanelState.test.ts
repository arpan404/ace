import { ThreadId } from "@ace/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  resolveRightSidePanelModeAfterDiffClose,
  resolveThreadRightSidePanelStorageKeys,
  resetThreadRightSidePanelState,
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
      Schema.Literals(["browser", "editor", "summary"]),
    );
    setLocalStorageItem(
      keys.mode,
      "diff",
      Schema.NullOr(Schema.Literals(["browser", "diff", "editor", "summary"])),
    );
    setLocalStorageItem(keys.reviewOpen, true, Schema.Boolean);
    setLocalStorageItem(keys.visible, false, Schema.Boolean);

    resetThreadRightSidePanelState(threadId);

    expect(
      getLocalStorageItem(keys.browserMode, Schema.Literals(["closed", "full", "split"])),
    ).toBe(null);
    expect(getLocalStorageItem(keys.diffOpen, Schema.Boolean)).toBe(null);
    expect(getLocalStorageItem(keys.editorOpen, Schema.Boolean)).toBe(null);
    expect(getLocalStorageItem(keys.fullscreen, Schema.Boolean)).toBe(null);
    expect(
      getLocalStorageItem(keys.lastNonDiffMode, Schema.Literals(["browser", "editor", "summary"])),
    ).toBe(null);
    expect(
      getLocalStorageItem(
        keys.mode,
        Schema.NullOr(Schema.Literals(["browser", "diff", "editor", "summary"])),
      ),
    ).toBe(null);
    expect(getLocalStorageItem(keys.reviewOpen, Schema.Boolean)).toBe(null);
    expect(getLocalStorageItem(keys.visible, Schema.Boolean)).toBe(null);

    removeLocalStorageItem(keys.browserMode);
    removeLocalStorageItem(keys.diffOpen);
    removeLocalStorageItem(keys.editorOpen);
    removeLocalStorageItem(keys.fullscreen);
    removeLocalStorageItem(keys.lastNonDiffMode);
    removeLocalStorageItem(keys.mode);
    removeLocalStorageItem(keys.reviewOpen);
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
});
