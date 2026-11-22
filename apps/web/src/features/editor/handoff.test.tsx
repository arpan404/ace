import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, expect, test } from "vitest";
import { createBufferRegistry } from "@/features/editor-workbench/buffers/registry.ts";
import {
  fakeDisk,
  inlineMerge,
  manualTime,
  memoryDrafts,
  ready,
  settle,
} from "@/features/editor-workbench/buffers/test-support.ts";
import type { TextBuffer } from "@/features/editor-workbench/buffers/types.ts";
import { CodeEditor } from "./editor.tsx";

/*
 * A layout change mounts the editor again somewhere else in the tree (a split, a moved group,
 * full view). The new view shows the code coloured at once and keeps the keyboard.
 */

beforeAll(ready);

const code = 'export const App = () => <button title="Hello">{42}</button>;\n';
const file = { root: "m1/t1", path: "src/app.tsx" };

async function openBuffer() {
  const time = manualTime();
  const registry = createBufferRegistry({
    files: fakeDisk({ "src/app.tsx": code }).port,
    drafts: memoryDrafts().store,
    merge: inlineMerge().port,
    now: time.now,
    schedule: time.schedule,
    ready,
  });
  const lease = registry.open(file);
  lease.setVisible(true);
  await settle();
  return lease.buffer;
}

function View({ buffer, label }: { buffer: TextBuffer; label: string }) {
  const view = buffer.view();
  if (!view) return null;
  return (
    <section aria-label={label}>
      <CodeEditor
        document={view}
        text={view.doc.text()}
        path={file.path}
        label={label}
        statusLine={false}
        highlightDelay={0}
      />
    </section>
  );
}

const coloured = (label: string) =>
  document
    .querySelector(`section[aria-label="${label}"] [data-line="0"]`)
    ?.querySelectorAll('[style*="--source-token-light"]').length ?? 0;

/** The editor alone, or moved into a split: a new place in the tree mounts it again. */
function Layout({ buffer, split }: { buffer: TextBuffer; split: boolean }) {
  const editor = <View key={split ? "b" : "a"} buffer={buffer} label="code" />;
  return split ? <div data-split>{editor}</div> : editor;
}

async function mounted() {
  const buffer = await openBuffer();
  const { rerender } = render(<Layout buffer={buffer} split={false} />);
  await waitFor(() => expect(coloured("code")).toBeGreaterThan(3));
  return {
    move: (split: boolean) => act(() => rerender(<Layout buffer={buffer} split={split} />)),
  };
}

test("a view mounted again by a layout change draws its colours on the first frame", async () => {
  const { move } = await mounted();

  move(true);

  expect(document.querySelector("[data-highlight-pending]")).toBeNull();
  expect(coloured("code")).toBeGreaterThan(3);
});

test("the keyboard stays in the editor through a layout change", async () => {
  const { move } = await mounted();
  act(() => screen.getByRole("textbox", { name: "app.tsx" }).focus());

  move(true);

  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "app.tsx" })),
  );
  expect(document.querySelector("[data-split]")?.contains(document.activeElement)).toBe(true);
});

test("an editor that did not have the keyboard does not take it after a layout change", async () => {
  const { move } = await mounted();
  const elsewhere = document.createElement("input");
  document.body.append(elsewhere);
  elsewhere.focus();

  move(true);
  await settle();

  expect(document.activeElement).toBe(elsewhere);
  elsewhere.remove();
});
