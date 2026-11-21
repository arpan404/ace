import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { expect, test, vi } from "vitest";
import { CodeEditor } from "./editor.tsx";
import type { EditorHandle } from "./types.ts";

/*
 * Drops on the editor's text input: a tab or a file dragged inside ace is the group's to place,
 * never text to type; text dragged in from elsewhere lands at the caret.
 */

function transfer(data: Record<string, string>) {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
    dropEffect: "none",
    effectAllowed: "all",
  };
}

async function openEditor(onGroupDrop: (event: { defaultPrevented: boolean }) => void) {
  const ref = createRef<EditorHandle>();
  render(
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- stands in for the group's drop zone.
    <div onDrop={(event) => onGroupDrop(event)}>
      <CodeEditor
        ref={ref}
        path="src/example.ts"
        label="Editor"
        text={"one\ntwo"}
        highlightDelay={60_000}
      />
    </div>,
  );
  const box = await screen.findByRole("textbox", { name: "example.ts" });
  await waitFor(() => expect(ref.current).toBeTruthy());
  act(() => {
    ref.current?.focus();
    ref.current?.setSelections([
      { anchor: { line: 0, column: 3 }, head: { line: 0, column: 3 } },
    ]);
  });
  return { ref, box };
}

test("a dragged editor tab dropped on the code types nothing and reaches the group", async () => {
  const group = vi.fn();
  const { ref, box } = await openEditor(group);

  fireEvent.drop(box, {
    dataTransfer: transfer({
      "application/x-ace-editor-tab": JSON.stringify({ group: "g1", path: "src/other.ts" }),
      "text/plain": "src/other.ts",
    }),
  });

  expect(ref.current?.text()).toBe("one\ntwo");
  expect(group).toHaveBeenCalledTimes(1);
});

test("a file dragged from the explorer types nothing into the code", async () => {
  const group = vi.fn();
  const { ref, box } = await openEditor(group);

  fireEvent.drop(box, {
    dataTransfer: transfer({
      "application/x-ace-tree-entries": "[]",
      "text/plain": "packages/ui-core/src/workspace-tabs.ts",
    }),
  });

  expect(ref.current?.text()).toBe("one\ntwo");
  expect(group).toHaveBeenCalledTimes(1);
});

test("plain text dragged in from elsewhere is inserted at the caret", async () => {
  const { ref, box } = await openEditor(() => {});

  fireEvent.drop(box, { dataTransfer: transfer({ "text/plain": "!" }) });

  expect(ref.current?.text()).toBe("one!\ntwo");
});
