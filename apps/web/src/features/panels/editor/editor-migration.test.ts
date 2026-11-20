import { groupsOf, parseLayout } from "@ace/ui-core/editor-workbench";
import {
  emptyWorkspace,
  type ScopeWorkspace,
  type WorkspaceTab,
} from "@ace/ui-core/workspace-tabs";
import { describe, expect, it } from "vitest";
import { editorLayoutOf } from "./editor-layout.ts";
import { draftsOf, upgradeWorkspace, withoutDrafts } from "./editor-migration.ts";

const tab = (key: string, kind: string, data?: unknown, pinned = false): WorkspaceTab => {
  const [, id = kind] = key.split(/:(.*)/);
  return { key, kind, id, pinned, ...(data === undefined ? {} : { data }) };
};

const stored = (tabs: WorkspaceTab[], active?: string, open = true): ScopeWorkspace => ({
  ...emptyWorkspace,
  tabs,
  active,
  open,
});

const draft = { text: "mine", original: "theirs", version: "v3" };

describe("moving per-file panel tabs into the editor on first load", () => {
  const before = stored(
    [
      tab("work", "work", undefined, true),
      tab("files", "files", { query: "src", side: "files" }, true),
      tab("changes", "changes"),
      tab("files:file:src/a.ts", "files", { path: "src/a.ts" }),
      tab("files:file:src/b.ts", "files", { path: "src/b.ts", preview: true, draft }),
      tab("browser", "browser"),
    ],
    "files:file:src/b.ts",
  );
  const after = upgradeWorkspace(before);

  it("puts every file in one group, in order, with preview flags, the showing one active", () => {
    const layout = editorLayoutOf(after);
    const [group] = groupsOf(layout);
    expect(groupsOf(layout)).toHaveLength(1);
    expect(group?.tabs.map((each) => [each.path, each.preview])).toEqual([
      ["src/a.ts", false],
      ["src/b.ts", true],
    ]);
    expect(group?.active).toBe("src/b.ts");
    expect(layout.explorer.side).toBe("files");
  });

  it("leaves the tools where they were and the editor where the Files tab was, pinned, showing", () => {
    expect(after.tabs.map((each) => each.key)).toEqual(["work", "editor", "changes", "browser"]);
    expect(after.tabs[1]?.pinned).toBe(true);
    expect(after.active).toBe("editor");
    expect(after.open).toBe(true);
  });

  it("carries unsaved drafts in the layout until the draft store has them", () => {
    const layout = editorLayoutOf(after);
    expect(draftsOf(layout)).toEqual([{ path: "src/b.ts", ...draft }]);
    const kept = withoutDrafts(layout);
    expect(draftsOf(kept)).toEqual([]);
    // The rest of the layout survives the drafts leaving it, and a reload.
    expect(groupsOf(parseLayout(kept, "g9"))[0]?.tabs).toHaveLength(2);
  });

  it("happens once: a workspace with no old file tabs is left as it is", () => {
    expect(upgradeWorkspace(after)).toBe(after);
    const plain = stored([tab("work", "work")], "work");
    expect(upgradeWorkspace(plain)).toBe(plain);
  });

  it("keeps a closed panel closed and another tool showing", () => {
    const quiet = upgradeWorkspace(
      stored(
        [tab("changes", "changes"), tab("files:file:a.ts", "files", { path: "a.ts" })],
        "changes",
        false,
      ),
    );
    expect(quiet.active).toBe("changes");
    expect(quiet.open).toBe(false);
    expect(groupsOf(editorLayoutOf(quiet))[0]?.tabs.map((each) => each.path)).toEqual(["a.ts"]);
  });
});
