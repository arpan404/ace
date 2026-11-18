import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { expect, test } from "vitest";
import { useEditorDocument, type EditorDocumentState } from "./use-editor.ts";

/*
 * The document's edit batches: each applied edit is handed to the view in the line coordinates
 * of the document it produced, even when several land before React renders again.
 */

function Probe(props: { capture(state: EditorDocumentState): void }) {
  const state = useEditorDocument({ text: "a\nb\nc", path: "notes.txt" });
  useEffect(() => {
    props.capture(state);
  });
  return null;
}

test("two edits before a render are taken as two batches in their own coordinates", async () => {
  let latest: EditorDocumentState | undefined;
  render(<Probe capture={(state) => (latest = state)} />);
  await waitFor(() => expect(latest?.doc).toBeTruthy());
  const state = latest;
  if (!state?.doc) throw new Error("The document did not load");

  act(() => {
    state.doc?.setSelections([{ anchor: { line: 0, column: 0 }, head: { line: 0, column: 0 } }]);
    state.edit((doc) => doc.insertNewline());
    state.edit((doc) => doc.insertNewline());
  });

  const batches = state.takeChanges();
  expect(batches).toHaveLength(2);
  expect(batches.map((batch) => batch.lines)).toEqual([4, 5]);
  expect(batches[1]?.spans[0]?.firstLine).toBe(1);
  expect(state.takeChanges()).toEqual([]);
});
