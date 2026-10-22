import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { MarkdownEditor } from "./markdown-editor.tsx";

function Example(props: { initial?: string; onSubmit?: (text: string) => void }) {
  const [text, setText] = useState(props.initial ?? "");
  return (
    <TooltipProvider delay={0}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit?.(text);
        }}
      >
        <MarkdownEditor label="Comment" value={text} onChange={setText} />
      </form>
    </TooltipProvider>
  );
}

function setup(initial = "") {
  const user = userEvent.setup();
  render(<Example initial={initial} />);
  const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" });
  return { user, field };
}

async function select(field: HTMLTextAreaElement, text: string) {
  await userEvent.click(field);
  const start = field.value.indexOf(text);
  field.setSelectionRange(start, start + text.length);
}

test("bold wraps the selected text, and Ctrl+B does the same", async () => {
  const { user, field } = setup("ship it now");
  await select(field, "ship");
  await user.click(screen.getByRole("button", { name: "Bold" }));
  expect(field.value).toBe("**ship** it now");
  // The words stay selected, so typing replaces them as it would after any edit.
  expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe("ship");
  await select(field, "now");
  await user.keyboard("{Control>}b{/Control}");
  expect(field.value).toBe("**ship** it **now**");
});

test("bold on bold text takes the bold off", async () => {
  const { user, field } = setup("**ship** it");
  await select(field, "ship");
  await user.click(screen.getByRole("button", { name: "Bold" }));
  expect(field.value).toBe("ship it");
});

test("bold with nothing selected leaves the caret between the marks to type into", async () => {
  const { user, field } = setup();
  await user.click(field);
  await user.click(screen.getByRole("button", { name: "Bold" }));
  await user.keyboard("loud");
  expect(field.value).toBe("**loud**");
});

test("a link around selected words selects the address to type over", async () => {
  const { user, field } = setup("see the docs");
  await select(field, "the docs");
  await user.keyboard("{Control>}k{/Control}");
  await user.keyboard("https://ace.dev");
  expect(field.value).toBe("see [the docs](https://ace.dev)");
});

test("a numbered list numbers each selected line, and pressing it again takes the numbers off", async () => {
  const { user, field } = setup("milk\neggs\nbread");
  await user.click(field);
  field.setSelectionRange(0, field.value.length);
  await user.click(screen.getByRole("button", { name: "Numbered list" }));
  expect(field.value).toBe("1. milk\n2. eggs\n3. bread");
  await user.click(screen.getByRole("button", { name: "Numbered list" }));
  expect(field.value).toBe("milk\neggs\nbread");
});

test("a bulleted line turned into a task keeps its text", async () => {
  const { user, field } = setup("- ship it");
  await user.click(field);
  await user.click(screen.getByRole("button", { name: "Task list" }));
  expect(field.value).toBe("- [ ] ship it");
});

test("Enter continues a bulleted list and an empty item ends it", async () => {
  const { user, field } = setup();
  await user.type(field, "- one{Enter}two{Enter}");
  expect(field.value).toBe("- one\n- two\n- ");
  await user.keyboard("{Enter}");
  expect(field.value).toBe("- one\n- two\n");
  await user.keyboard("after");
  expect(field.value).toBe("- one\n- two\nafter");
});

test("Enter in a numbered list counts on, and in a task list adds an open box", async () => {
  const { user, field } = setup();
  await user.type(field, "1. first{Enter}second{Enter}");
  expect(field.value).toBe("1. first\n2. second\n3. ");
  await user.clear(field);
  await user.type(field, "- [[x] done{Enter}next");
  expect(field.value).toBe("- [x] done\n- [ ] next");
});

test("Tab nests a list item under the one above and Shift+Tab brings it back", async () => {
  const { user, field } = setup();
  await user.type(field, "- one{Enter}two");
  await user.keyboard("{Tab}");
  expect(field.value).toBe("- one\n  - two");
  expect(document.activeElement).toBe(field);
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(field.value).toBe("- one\n- two");
});

test("pasting a URL over selected text makes a link", async () => {
  const { user, field } = setup("read the guide first");
  await select(field, "the guide");
  await user.paste("https://ace.dev/guide");
  expect(field.value).toBe("read [the guide](https://ace.dev/guide) first");
});

test("pasting ordinary text over a selection replaces it as usual", async () => {
  const { user, field } = setup("read the guide");
  await select(field, "guide");
  await user.paste("manual");
  expect(field.value).toBe("read the manual");
});

test("Preview shows the rendered Markdown, and Write brings the text back", async () => {
  const { user } = setup("Ship **only** this");
  await user.click(screen.getByRole("button", { name: "Preview" }));
  const preview = screen.getByRole("region", { name: "Comment preview" });
  const strong = await within(preview).findByText("only");
  expect(strong.closest("strong")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Bold" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Write" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }).value).toBe(
    "Ship **only** this",
  );
});

test("Ctrl+Enter submits the form the editor is in", async () => {
  const sent: string[] = [];
  const user = userEvent.setup();
  render(<Example onSubmit={(text) => sent.push(text)} />);
  await user.type(screen.getByRole("textbox", { name: "Comment" }), "Looks good");
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(sent).toEqual(["Looks good"]);
});
