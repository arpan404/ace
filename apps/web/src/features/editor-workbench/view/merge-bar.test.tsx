import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { one } from "./editor-test-dom.ts";
import { mountEditor, root, tab } from "./editor-test-support.tsx";

/*
 * An agent changes a file the person is editing (spec 46), end to end on the real registry and
 * merge: one bar at the editor's foot says what happened in words, Merge lands what doesn't
 * overlap, and blocks both sides changed are answered one by one. Nothing is ever written over
 * the disk without a save, and the person's text is never lost.
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const claude = { kind: "agent", agent: "Claude Code", threadId: "t1", turn: 2 } as const;
const start = "one\ntwo\nthree\nfour\nfive\n";

async function editing() {
  const editor = await mountEditor(one([tab("places.ts")]), {
    author: claude,
    overrides: { renderCompare: () => <div /> },
  });
  await editor.changeOnDisk("places.ts", start);
  const buffer = () => {
    const found = editor.registry.get({ root, path: "places.ts" });
    if (!found) throw new Error("places.ts is not open");
    return found;
  };
  /** The person types `text` over 0-based `line`. */
  const typeOver = (line: number, text: string) => {
    const doc = buffer().document();
    if (!doc) throw new Error("no document");
    act(() => {
      doc.apply([
        { range: { start: { line, column: 0 }, end: { line, column: doc.line(line).length } }, text },
      ]);
      buffer().edited();
    });
  };
  return { editor, buffer, typeOver };
}

const bar = () => screen.getByText((_, node) => node?.getAttribute("data-part") === "editor-notice");

test("the bar at the editor's foot says who changed which lines while the person edited which", async () => {
  const { editor, typeOver } = await editing();
  typeOver(4, "five, mine");
  await editor.changeOnDisk("places.ts", "one\nTWO\nTHREE\nfour\nfive\n");

  await waitFor(() =>
    expect(bar().textContent).toContain(
      "Claude Code changed lines 2–3 while you were editing line 5. No overlap.",
    ),
  );
  // At the foot: after the editor, not under the breadcrumbs.
  const area = document.querySelector('[data-part="buffer-editor"]');
  expect(area?.compareDocumentPosition(bar()) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(within(bar()).getByRole("button", { name: "Merge" })).toBeTruthy();
  expect(within(bar()).getByRole("button", { name: "Compare" })).toBeTruthy();
});

test("Merge lands both sides when they don't overlap, unsaved, and writes nothing", async () => {
  const { editor, buffer, typeOver } = await editing();
  typeOver(4, "five, mine");
  await editor.changeOnDisk("places.ts", "one\nTWO\nthree\nfour\nfive\n");

  fireEvent.click(within(bar()).getByRole("button", { name: "Merge" }));

  await waitFor(() => expect(buffer().snapshot().clash).toBeUndefined());
  expect(buffer().document()?.text()).toBe("one\nTWO\nthree\nfour\nfive, mine\n");
  expect(buffer().snapshot().dirty).toBe(true);
  expect(editor.disk.text("places.ts")).toBe("one\nTWO\nthree\nfour\nfive\n");
});

test("overlapping blocks are answered one by one; Save waits, and undo brings the person's text back", async () => {
  const { editor, buffer, typeOver } = await editing();
  typeOver(1, "two, mine");
  typeOver(4, "five, mine");
  await editor.changeOnDisk("places.ts", "one\ntwo, agent\nthree\nfour\nfive, agent\n");
  await waitFor(() => expect(bar().textContent).toContain("2 places overlap."));

  fireEvent.click(within(bar()).getByRole("button", { name: "Merge" }));
  const blocks = await screen.findByRole("region", { name: "Overlapping changes" });
  const [first, second] = within(blocks).getAllByRole("region");
  if (!first || !second) throw new Error("two blocks expected");
  expect(first.getAttribute("aria-label")).toBe("Overlap 1 of 2, near line 2");
  expect(first.textContent).toContain("two, mine");
  expect(first.textContent).toContain("two, agent");
  expect(first.textContent).toContain("Claude Code's");

  // Until each block is answered, saving refuses and the disk keeps the agent's version.
  expect((await buffer().save()).kind).toBe("unanswered");
  expect(editor.disk.text("places.ts")).toBe("one\ntwo, agent\nthree\nfour\nfive, agent\n");

  fireEvent.click(within(first).getByRole("button", { name: "Take theirs" }));
  await waitFor(() => expect(bar().textContent).toContain("Choose a side for the 1 left"));
  fireEvent.click(within(second).getByRole("button", { name: "Keep mine" }));

  await waitFor(() => expect(buffer().snapshot().clash).toBeUndefined());
  expect(screen.queryByRole("region", { name: "Overlapping changes" })).toBeNull();
  expect(buffer().document()?.text()).toBe("one\ntwo, agent\nthree\nfour\nfive, mine\n");
  expect(buffer().snapshot().dirty).toBe(true);
  expect(editor.disk.text("places.ts")).toBe("one\ntwo, agent\nthree\nfour\nfive, agent\n");

  // The merge is one undoable step: the person's own text is back.
  act(() => {
    buffer().document()?.undo();
    buffer().edited();
  });
  expect(buffer().document()?.text()).toBe("one\ntwo, mine\nthree\nfour\nfive, mine\n");
});

test("Take all theirs answers every block at once", async () => {
  const { editor, buffer, typeOver } = await editing();
  typeOver(1, "two, mine");
  await editor.changeOnDisk("places.ts", "one\ntwo, agent\nthree\nfour\nfive\n");
  fireEvent.click(within(bar()).getByRole("button", { name: "Merge" }));
  await screen.findByRole("region", { name: "Overlapping changes" });

  fireEvent.click(within(bar()).getByRole("button", { name: "Take all theirs" }));

  await waitFor(() => expect(buffer().snapshot().clash).toBeUndefined());
  expect(buffer().document()?.text()).toBe("one\ntwo, agent\nthree\nfour\nfive\n");
});
