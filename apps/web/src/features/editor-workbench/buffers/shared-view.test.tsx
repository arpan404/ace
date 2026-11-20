import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type Ref } from "react";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { CodeEditor, type EditorHandle } from "@/features/editor";
import { createBufferRegistry } from "./registry.ts";
import { fakeDisk, inlineMerge, manualTime, memoryDrafts, ready, settle } from "./test-support.ts";
import type { TextBuffer } from "./types.ts";

/*
 * The document seam: CodeEditor shows a buffer's document instead of making its own, so two
 * views share one text, and text the registry lands reaches the mounted view.
 */

beforeAll(ready);
beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const file = { root: "m1/t1", path: "src/places.ts" };

async function setup(text: string) {
  const disk = fakeDisk({ "src/places.ts": text });
  const time = manualTime();
  const registry = createBufferRegistry({
    files: disk.port,
    drafts: memoryDrafts().store,
    merge: inlineMerge().port,
    now: time.now,
    schedule: time.schedule,
    ready,
  });
  const lease = registry.open(file);
  lease.setVisible(true);
  await settle();
  return { disk, registry, buffer: lease.buffer };
}

function View({
  ref,
  buffer,
  label,
}: {
  buffer: TextBuffer;
  label: string;
  ref: Ref<EditorHandle>;
}) {
  const view = buffer.view();
  if (!view) return null;
  return (
    <CodeEditor
      ref={ref}
      document={view}
      text={view.doc.text()}
      path={file.path}
      label={label}
      statusLine={false}
      highlightDelay={60_000}
      onEdit={() => buffer.edited()}
    />
  );
}

test("two editors of one buffer show one text: typing in one shows in the other", async () => {
  const { buffer } = await setup("one\ntwo\n");
  const left = createRef<EditorHandle>();
  const right = createRef<EditorHandle>();
  render(
    <>
      <View buffer={buffer} label="Left" ref={left} />
      <View buffer={buffer} label="Right" ref={right} />
    </>,
  );
  await waitFor(() => expect(left.current && right.current).toBeTruthy());

  act(() => left.current?.focus());
  act(() =>
    left.current?.setSelections([{ anchor: { line: 0, column: 3 }, head: { line: 0, column: 3 } }]),
  );
  await userEvent.keyboard("!");

  expect(right.current?.text()).toBe("one!\ntwo\n");
  expect(buffer.snapshot().dirty).toBe(true);
});

test("typing in one split redraws the other split's rows of the same file", async () => {
  const { buffer } = await setup("one\ntwo\n");
  const left = createRef<EditorHandle>();
  const right = createRef<EditorHandle>();
  render(
    <>
      <View buffer={buffer} label="Left" ref={left} />
      <View buffer={buffer} label="Right" ref={right} />
    </>,
  );
  await waitFor(() => expect(left.current && right.current).toBeTruthy());
  const rightRows = screen.getByRole("region", { name: "Right" });
  expect(within(rightRows).getByText("one")).toBeTruthy();

  act(() => left.current?.focus());
  act(() =>
    left.current?.setSelections([{ anchor: { line: 0, column: 3 }, head: { line: 0, column: 3 } }]),
  );
  await userEvent.keyboard("!{Enter}three");

  expect(await within(rightRows).findByText("one!")).toBeTruthy();
  expect(within(rightRows).getByText("three")).toBeTruthy();
});

test("a merge the registry lands shows in the mounted editor, and unmounting keeps the text", async () => {
  const { disk, registry, buffer } = await setup("a\nb\nc\nd\n");
  const handle = createRef<EditorHandle>();
  const { unmount } = render(<View buffer={buffer} label="Editor" ref={handle} />);
  await waitFor(() => expect(handle.current).toBeTruthy());
  act(() => handle.current?.focus());
  act(() =>
    handle.current?.setSelections([
      { anchor: { line: 0, column: 1 }, head: { line: 0, column: 1 } },
    ]),
  );
  await userEvent.keyboard("!");

  disk.write("src/places.ts", "a\nb\nc\ntheirs\n");
  registry.diskChanged(file);
  await settle();
  await act(() => buffer.merge());

  expect(handle.current?.text()).toBe("a!\nb\nc\ntheirs\n");
  expect(await screen.findByText("theirs")).toBeTruthy();
  unmount();
  expect(buffer.document()?.text()).toBe("a!\nb\nc\ntheirs\n");
});
