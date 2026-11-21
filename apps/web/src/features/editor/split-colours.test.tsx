import { act, render, waitFor } from "@testing-library/react";
import { useState } from "react";
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
 * Colours survive layout: a second view of the same buffer (a split), a view that remounts
 * (a group moved or a full view), and the first view after both, each draw coloured code.
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

test("after a split, both views of the file keep their colours, and a remount colours again", async () => {
  const buffer = await openBuffer();
  let split: (views: string[]) => void = () => {};
  function Groups() {
    const [views, setViews] = useState(["left"]);
    split = setViews;
    return (
      <div>
        {views.map((label) => (
          <View key={label} buffer={buffer} label={label} />
        ))}
      </div>
    );
  }
  render(<Groups />);
  await waitFor(() => expect(coloured("left")).toBeGreaterThan(3));

  act(() => split(["left", "right"]));
  await waitFor(() => expect(coloured("right")).toBeGreaterThan(3));
  expect(coloured("left")).toBeGreaterThan(3);

  // A drag moves the left group: it mounts again under a new place in the tree.
  act(() => split(["right", "moved"]));
  await waitFor(() => expect(coloured("moved")).toBeGreaterThan(3));
  expect(coloured("right")).toBeGreaterThan(3);
});
