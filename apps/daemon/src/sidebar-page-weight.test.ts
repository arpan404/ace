import { Thread, type ThreadListWindow } from "@ace/protocol";
import { expect, test } from "vitest";
import { SidebarPageWeight } from "./sidebar-page-weight.ts";

test("page admission accounts for UTF-8, JSON escaping, window metadata and array separators", () => {
  const weight = new SidebarPageWeight();
  const entries = ["plain", "日本語 😀", 'quoted "title"\n\u0000', "\ud800"].map((title, index) =>
    Thread.parse({
      id: `thread-${index}`,
      workspaceId: "workspace",
      provider: "codex",
      title,
      status: { state: "done" },
      createdAt: 1,
      updatedAt: 2,
    }),
  );
  const window: ThreadListWindow = {
    total: 4,
    counts: [{ id: "日本語", threads: 4 }],
    before: { at: 2, id: entries[0]!.id },
  };
  for (const threads of [[], entries.slice(0, 1), entries]) {
    const page = { threads, window };
    expect(weight.bytes(page)).toBe(Buffer.byteLength(JSON.stringify(page)));
  }
  const changed = { ...entries[0]!, title: "A larger replacement title 😀" };
  const page = { threads: [changed, ...entries.slice(1)], window: { ...window, before: null } };
  expect(weight.bytes(page)).toBe(Buffer.byteLength(JSON.stringify(page)));
});
