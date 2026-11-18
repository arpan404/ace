import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { expect, test } from "vitest";
import { useEditorDocument, type EditBatch, type EditorDocumentState } from "./use-editor.ts";

/*
 * The document's edit batches: each applied edit is handed over as it happens, in the line
 * coordinates of the document it produced, even when several land before React renders again.
 * A layout that measures text hears about an edit before it can read the new document.
 */

function Probe(props: {
  capture(state: EditorDocumentState): void;
  onApplied(batch: EditBatch): void;
}) {
  const state = useEditorDocument({
    text: "a\nb\nc",
    path: "notes.txt",
    onApplied: props.onApplied,
  });
  useEffect(() => {
    props.capture(state);
  });
  return null;
}

test("each edit is handed over as it is applied, in its own coordinates", async () => {
  const batches: EditBatch[] = [];
  let latest: EditorDocumentState | undefined;
  render(
    <Probe capture={(state) => (latest = state)} onApplied={(batch) => batches.push(batch)} />,
  );
  await waitFor(() => expect(latest?.doc).toBeTruthy());
  const state = latest;
  if (!state?.doc) throw new Error("The document did not load");

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
