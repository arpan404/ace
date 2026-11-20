import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createBufferRegistry } from "@/features/editor-workbench/index.ts";
import {
  fakeDisk,
  inlineMerge,
  manualTime,
  memoryDrafts,
  ready,
  settle,
} from "@/features/editor-workbench/buffers/test-support.ts";
import { markers, openThread, select } from "./test/annotate-thread.tsx";

/*
 * One file in two Deck groups: two editors over the file's one buffer (W2). An annotation's range
 * is mapped once per edit to the document, whichever view typed, so its marker stays on its code.
 */

beforeAll(ready);
beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const source = ["const a = 1;", "const b = 2;", "const c = a + b;", "export { c };"].join("\n");
const path = "src/sum.ts";

async function twoViews() {
  const disk = fakeDisk({ [path]: source });
  const time = manualTime();
  const registry = createBufferRegistry({
    files: disk.port,
    drafts: memoryDrafts().store,
    merge: inlineMerge().port,
    now: time.now,
    schedule: time.schedule,
    ready,
  });
  const lease = registry.open({ root: "m1/t1", path });
  lease.setVisible(true);
  await settle();
  const shared = lease.buffer.view();
  if (!shared) throw new Error("The buffer has no document");
  const opened = await openThread([
    { path, text: source, shared, view: 1 },
    { path, text: source, shared, view: 2 },
  ]);
  const first = screen.getByRole("region", { name: `Editor ${path}` });
  const second = screen.getByRole("region", { name: `Editor ${path}#2` });
  /** An agent writes the file and the watcher says so: the registry lands it in the views. */
  const agentWrites = async (text: string) => {
    disk.write(path, text);
    registry.diskChanged({ root: "m1/t1", path });
    await act(settle);
  };
  return { ...opened, shared, first, second, agentWrites };
}

async function annotateLine3(handle: ReturnType<Awaited<ReturnType<typeof twoViews>>["editor"]>) {
  select(handle, [2, 0], [2, 16]);
  await userEvent.keyboard("{Meta>}{Shift>}a{/Shift}{/Meta}");
  const popover = await screen.findByRole("dialog", { name: "New annotation" });
  await userEvent.type(within(popover).getByRole("textbox", { name: "Comment" }), "Check this");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

/** Two new lines typed at the top of the file through `handle`'s view. */
async function typeAtTop(handle: ReturnType<Awaited<ReturnType<typeof twoViews>>["editor"]>) {
  act(() => {
    handle.focus();
    handle.setSelections([{ anchor: { line: 0, column: 0 }, head: { line: 0, column: 0 } }]);
  });
  await userEvent.keyboard("// one{Enter}// two{Enter}");
}

test.each([
  ["the view the annotation was made in", path],
  ["the other view of the same file", `${path}#2`],
])("typing above an annotation in %s moves its marker once, onto its code", async (_, typer) => {
  const { editor, first, second, shared } = await twoViews();
  await annotateLine3(editor(path));
  expect(markers(first)).toEqual(["1@3"]);

  await typeAtTop(editor(typer));
  expect(shared.doc.line(4)).toBe("const c = a + b;");
  // Two lines in, both views mark line 5: moved by two lines, not four.
  await waitFor(() => expect(markers(first)).toEqual(["1@5"]));
  expect(markers(second)).toEqual(["1@5"]);
});

test("an agent's write landed in both views moves the marker once, onto its code", async () => {
  const { editor, first, second, agentWrites } = await twoViews();
  await annotateLine3(editor(path));
  await agentWrites(`// one\n// two\n${source}`);
  await waitFor(() => expect(markers(first)).toEqual(["1@5"]));
  expect(markers(second)).toEqual(["1@5"]);
});
