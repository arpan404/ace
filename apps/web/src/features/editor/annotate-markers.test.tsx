import { putDraft } from "@ace/ui-core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { ComposerDraftSchema } from "@/features/thread/composer/draft-store.ts";
import { markers, openThread, select } from "./test/annotate-thread.tsx";

/*
 * Saved code annotations in the editor: numbered markers in the gutter and a wash over their
 * range, drawn only for the rows on screen; pressing a marker reopens it. Several files collect
 * in one draft, and the draft brings them back after a reload.
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const source = ["const a = 1;", "const b = 2;", "const c = a + b;", "export { c };"].join("\n");
const chip = () => screen.queryByRole("button", { name: /^Show \d+ annotations?$/ });

async function annotate(path: string, comment: string) {
  await userEvent.keyboard("{Meta>}{Shift>}a{/Shift}{/Meta}");
  const popover = await screen.findByRole("dialog", { name: "New annotation" });
  await userEvent.type(within(popover).getByRole("textbox", { name: "Comment" }), comment);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  return path;
}

const washes = (number: number) =>
  [...document.querySelectorAll<HTMLElement>(`[data-annotated-range="${number}"]`)].map(
    (box) => `${box.style.top} ${box.style.left} ${box.style.width}`,
  );

test("a saved annotation shows its number at its first line and a wash over exactly its code", async () => {
  const { editor } = await openThread([{ path: "src/sum.ts", text: source }]);
  select(editor(), [1, 6], [2, 7]);
  await annotate("src/sum.ts", "Name these");

  expect(markers()).toEqual(["1@2"]);
  // Two rows: from "b" to the end of line 2 (and the line break), then line 3 up to "c".
  const rows = washes(1);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.split(" ")[0]).toBe("22px");
  expect(rows[1]?.split(" ")[0]).toBe("44px");
  expect(screen.getByRole("button", { name: "Annotation 1, lines 2–3" })).toBeTruthy();
});

test("pressing a marker reopens its comment to change it or delete it", async () => {
  const { editor } = await openThread([{ path: "src/sum.ts", text: source }]);
  select(editor(), [0, 0], [0, 12]);
  await annotate("src/sum.ts", "Inline this");

  await userEvent.click(screen.getByRole("button", { name: "Annotation 1, line 1" }));
  let popover = await screen.findByRole("dialog", { name: "Annotation 1" });
  const comment = within(popover).getByRole("textbox", { name: "Comment" });
  expect((comment as HTMLTextAreaElement).value).toBe("Inline this");
  await userEvent.clear(comment);
  await userEvent.type(comment, "Keep it, rename it");
  await userEvent.click(within(popover).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await userEvent.click(screen.getByRole("button", { name: "Annotation 1, line 1" }));
  popover = await screen.findByRole("dialog", { name: "Annotation 1" });
  expect(
    (within(popover).getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value,
  ).toBe("Keep it, rename it");
  await userEvent.click(within(popover).getByRole("button", { name: "Delete annotation 1" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(markers()).toEqual([]);
  expect(chip()).toBeNull();
});

test("annotations in two files collect in one draft, numbered in order, and close ranks", async () => {
  const { editor, container } = await openThread([
    { path: "src/a.ts", text: source },
    { path: "src/b.ts", text: source },
  ]);
  const [first, second] = [...container.querySelectorAll<HTMLElement>('[role="region"]')];
  if (!first || !second) throw new Error("Two editors expected");

  select(editor("src/a.ts"), [3, 0], [3, 13]);
  await annotate("src/a.ts", "Export default instead");
  select(editor("src/b.ts"), [0, 0], [1, 0]);
  await annotate("src/b.ts", "Unused");
  select(editor("src/b.ts"), [2, 0], [2, 5]);
  await annotate("src/b.ts", "let?");

  expect(chip()?.textContent).toBe("3 annotations");
  expect(markers(first)).toEqual(["1@4"]);
  expect(markers(second)).toEqual(["2@1", "3@3"]);

  await userEvent.click(within(first).getByRole("button", { name: "Annotation 1, line 4" }));
  const popover = await screen.findByRole("dialog", { name: "Annotation 1" });
  await userEvent.click(within(popover).getByRole("button", { name: "Delete annotation 1" }));
  await waitFor(() => expect(markers(second)).toEqual(["1@1", "2@3"]));
  expect(chip()?.textContent).toBe("2 annotations");
});

test("a stored draft brings the markers back after a reload", async () => {
  const first = await openThread([{ path: "src/sum.ts", text: source }]);
  select(first.editor(), [2, 6], [2, 7]);
  await annotate("src/sum.ts", "Rename c");
  const draft = first.drafts.at(-1);
  first.unmount();

  // Through the device's draft store, as a reload reads it back.
  const stored = putDraft([], "thread-1", {
    text: "",
    mentions: [],
    attachments: [],
    annotations: draft,
  });
  const read = ComposerDraftSchema.parse(JSON.parse(JSON.stringify(stored[0]?.[1])));

  await openThread([{ path: "src/sum.ts", text: source }], read.annotations);
  await waitFor(() => expect(markers()).toEqual(["1@3"]));
  expect(chip()?.textContent).toBe("1 annotation");
});

test("only annotations on rows the editor draws get markers", async () => {
  const long = Array.from({ length: 3000 }, (_, line) => `line ${line + 1}`).join("\n");
  const { editor } = await openThread([{ path: "src/long.ts", text: long }]);
  select(editor(), [1, 0], [1, 6]);
  await annotate("src/long.ts", "Near the top");
  select(editor(), [2800, 0], [2800, 6]);
  await annotate("src/long.ts", "Far below");

  expect(chip()?.textContent).toBe("2 annotations");
  expect(markers()).toEqual(["1@2"]);
  expect(washes(2)).toEqual([]);
});
