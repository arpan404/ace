import { bubbleContent } from "@ace/ui-core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { AnnotationsCard } from "@/features/annotations/index.ts";
import { markers, openThread, select } from "./test/annotate-thread.tsx";

/*
 * Code annotations leaving the editor: the composer's chip lists them with the Browser's, and
 * Send hands the agent one block naming each by `path:lines` with its exact code and the
 * person's words, which the sent message shows again as a card.
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const cart = ["export function total(items) {", "  let sum = 0;", "  return sum;", "}"].join("\n");
const view = ["export function Cart() {", "  return <ul />;", "}"].join("\n");

async function annotate(comment: string) {
  await userEvent.keyboard("{Meta>}{Shift>}a{/Shift}{/Meta}");
  const popover = await screen.findByRole("dialog", { name: "New annotation" });
  await userEvent.type(within(popover).getByRole("textbox", { name: "Comment" }), comment);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

async function twoAnnotations() {
  const thread = await openThread([
    { path: "src/cart/total.ts", text: cart },
    { path: "src/cart/view.tsx", text: view },
  ]);
  select(thread.editor("src/cart/total.ts"), [1, 2], [2, 12]);
  await annotate("Sum the prices");
  select(thread.editor("src/cart/view.tsx"), [1, 9], [1, 15]);
  await annotate("Render the items");
  return thread;
}

test("Send hands the agent every annotation in order, by path:lines with its code and comment", async () => {
  const { sent } = await twoAnnotations();
  await userEvent.click(screen.getByRole("button", { name: "Send" }));

  const [text] = sent;
  expect(text).toContain('<code_annotations version="1" count="2">');
  const one = text?.indexOf("[1] src/cart/total.ts:2-3") ?? -1;
  const two = text?.indexOf("[2] src/cart/view.tsx:2") ?? -1;
  expect(one).toBeGreaterThan(0);
  expect(two).toBeGreaterThan(one);
  expect(text).toContain("Selection: line 2 column 3 to line 3 column 13");
  expect(text).toContain("Comment: Sum the prices\nCode:\n```\nlet sum = 0;\n  return sum\n```");
  expect(text).toContain("Comment: Render the items\nCode:\n```\n<ul />\n```");
  // They went with the message: the draft and the editor are clear of them.
  expect(screen.queryByRole("button", { name: /^Show \d+ annotations?$/ })).toBeNull();
  expect(markers()).toEqual([]);
});

test("the chip lists each with its file and lines; Edit reopens it in its editor, Remove drops it", async () => {
  await twoAnnotations();
  await userEvent.click(screen.getByRole("button", { name: "Show 2 annotations" }));
  const list = await screen.findByRole("list", { name: "Annotations" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    "1total.ts:2–3let sum = 0;Sum the prices",
    "2view.tsx:2<ul />Render the items",
  ]);

  await userEvent.click(
    within(list).getByRole("button", { name: "Edit annotation 2 on src/cart/view.tsx" }),
  );
  const popover = await screen.findByRole("dialog", { name: "Annotation 2" });
  expect(
    (within(popover).getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value,
  ).toBe("Render the items");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Annotation 2" })).toBeNull());

  await userEvent.click(screen.getByRole("button", { name: "Show 2 annotations" }));
  const again = await screen.findByRole("list", { name: "Annotations" });
  await userEvent.click(
    within(again).getByRole("button", { name: "Remove annotation 1 on src/cart/total.ts" }),
  );
  await waitFor(() => expect(markers()).toEqual(["1@2"]));
  expect(screen.getByRole("button", { name: "Show 1 annotation" })).toBeTruthy();
});

test("the sent message shows them as one card: file and lines, code, comment", async () => {
  const { sent, unmount } = await twoAnnotations();
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  unmount();

  const shown = bubbleContent([{ type: "text", text: `Tidy the cart${sent[0] ?? ""}` }]);
  expect(shown.text).toBe("Tidy the cart");
  render(<AnnotationsCard annotations={shown.annotations} code={shown.code} />);
  await userEvent.click(screen.getByText("2 annotations"));
  const list = screen.getByRole("list", { name: "Annotations on code" });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((row) => row.textContent),
  ).toEqual(["1total.ts:2–3let sum = 0;Sum the prices", "2view.tsx:2<ul />Render the items"]);
});
