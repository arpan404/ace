import { act, render, waitFor } from "@testing-library/react";
import { Activity, useEffect } from "react";
import { expect, test } from "vitest";
import { useEditorDocument, type EditBatch, type EditorDocumentState } from "./use-editor.ts";

/*
 * The document's edit batches: each applied edit is handed over as it happens, in the line
 * coordinates of the document it produced, even when several land before React renders again.
 * A layout that measures text hears about an edit before it can read the new document, and before
 * the page's own callback is told there is something to save.
 */

function Probe(props: {
  capture(state: EditorDocumentState): void;
  onApplied?(batch: EditBatch): void;
  onEdit?(): void;
  onBeforeEdit?(): void;
  onNoEdit?(): void;
}) {
  const state = useEditorDocument({
    text: "a\nb\nc",
    path: "notes.txt",
    ...(props.onApplied ? { onApplied: props.onApplied } : {}),
    ...(props.onEdit ? { onEdit: props.onEdit } : {}),
    ...(props.onBeforeEdit ? { onBeforeEdit: props.onBeforeEdit } : {}),
    ...(props.onNoEdit ? { onNoEdit: props.onNoEdit } : {}),
  });
  useEffect(() => {
    props.capture(state);
  });
  return null;
}

async function opened(props: Omit<Parameters<typeof Probe>[0], "capture">) {
  let latest: EditorDocumentState | undefined;
  render(<Probe {...props} capture={(state) => (latest = state)} />);
  await waitFor(() => expect(latest?.doc).toBeTruthy());
  const state = latest;
  if (!state?.doc) throw new Error("The document did not load");
  return state;
}

test("each edit is handed over as it is applied, in its own coordinates", async () => {
  const batches: EditBatch[] = [];
  const state = await opened({ onApplied: (batch) => batches.push(batch) });

  act(() => {
    state.doc?.setSelections([{ anchor: { line: 0, column: 0 }, head: { line: 0, column: 0 } }]);
    state.edit((doc) => doc.insertNewline());
    // Already handed over, before React has rendered the document the edit produced.
    expect(batches).toHaveLength(1);
    expect(batches[0]?.lines).toBe(4);
    state.edit((doc) => doc.insertNewline());
    expect(batches).toHaveLength(2);
    expect(batches[1]?.lines).toBe(5);
  });

  expect(batches[1]?.spans[0]?.firstLine).toBe(1);
  expect(batches[1]?.version).toBe(state.doc?.version());
});

test("the layout hears an edit before the page's own callback", async () => {
  const order: string[] = [];
  const state = await opened({
    onApplied: () => order.push("rows"),
    onEdit: () => order.push("page"),
  });

  act(() => {
    state.edit((doc) => doc.insertNewline());
  });

  // A page callback that reads the view must find the new rows already in the layout.
  expect(order).toEqual(["rows", "page"]);
});

test("a change that landed nothing lets go of the position it remembered", async () => {
  const events: string[] = [];
  const state = await opened({
    onBeforeEdit: () => events.push("before"),
    onNoEdit: () => events.push("no edit"),
    onApplied: () => events.push("applied"),
  });

  act(() => {
    // Nothing has been edited yet, so this undo changes nothing.
    const changed = state.edit((doc) => doc.undo());
    expect(changed).toBe(false);
  });

  expect(events).toEqual(["before", "no edit"]);
});

function Hideable(props: { mode: "visible" | "hidden"; capture(state: EditorDocumentState): void }) {
  return (
    <Activity mode={props.mode}>
      <Probe capture={props.capture} />
    </Activity>
  );
}

test("a tab hidden and shown again keeps its typed text and undo history", async () => {
  let latest: EditorDocumentState | undefined;
  const capture = (state: EditorDocumentState) => (latest = state);
  const view = render(<Hideable mode="visible" capture={capture} />);
  await waitFor(() => expect(latest?.doc).toBeTruthy());

  act(() => {
    latest?.select([{ anchor: { line: 2, column: 1 }, head: { line: 2, column: 1 } }]);
    latest?.edit((doc) => doc.insertText("!"));
  });
  expect(latest?.doc?.text()).toBe("a\nb\nc!");

  view.rerender(<Hideable mode="hidden" capture={capture} />);
  view.rerender(<Hideable mode="visible" capture={capture} />);
  await act(async () => {
    await Promise.resolve();
  });

  // The same buffer, still readable: nothing freed it while the tab was away.
  expect(latest?.doc?.text()).toBe("a\nb\nc!");
  act(() => {
    latest?.edit((doc) => doc.undo());
  });
  expect(latest?.doc?.text()).toBe("a\nb\nc");
});
