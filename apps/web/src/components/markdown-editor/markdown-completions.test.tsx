import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { MarkdownCompletionsProvider, type MarkdownCompletions } from "./completion-source.ts";
import { MarkdownEditor } from "./markdown-editor.tsx";

const people = [
  { login: "mira", name: "Mira Okafor" },
  { login: "milo", name: "Milo Park" },
  { login: "sam", name: "Sam Lindqvist" },
];
const references = [
  { number: 231, title: "Pull requests page", kind: "pr" as const, state: "open" as const },
  {
    number: 12,
    title: "Daemon forgets the port",
    kind: "issue" as const,
    state: "closed" as const,
  },
];
const source: MarkdownCompletions = {
  people: async (query) =>
    people.filter((p) => p.login.startsWith(query) || p.name.toLowerCase().includes(query)),
  references: async (query) =>
    references.filter((r) => String(r.number).startsWith(query) || r.title.includes(query)),
};

function Example(props: { initial?: string; sent?: string[] }) {
  const [text, setText] = useState(props.initial ?? "");
  return (
    <TooltipProvider delay={0}>
      <MarkdownCompletionsProvider value={source}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.sent?.push(text);
          }}
        >
          <MarkdownEditor label="Comment" value={text} onChange={setText} />
        </form>
      </MarkdownCompletionsProvider>
    </TooltipProvider>
  );
}

function setup(initial = "", sent?: string[]) {
  const user = userEvent.setup();
  render(<Example initial={initial} {...(sent ? { sent } : {})} />);
  return { user, field: screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }) };
}

const options = async (name: string) =>
  within(await screen.findByRole("listbox", { name })).getAllByRole("option");

test("typing @ lists people matching what follows, and Enter inserts the login", async () => {
  const { user, field } = setup();
  await user.type(field, "thanks @mi");
  const rows = await options("People");
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "mira, Mira Okafor",
    "milo, Milo Park",
  ]);
  await user.keyboard("{Enter}");
  expect(field.value).toBe("thanks @mira ");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("arrow keys move the highlight and Tab takes the highlighted person", async () => {
  const { user, field } = setup();
  await user.type(field, "@mi");
  await options("People");
  await user.keyboard("{ArrowDown}");
  expect(field.getAttribute("aria-activedescendant")).toBe(
    (await options("People"))[1]?.getAttribute("id"),
  );
  await user.keyboard("{Tab}");
  expect(field.value).toBe("@milo ");
});

test("Escape closes the list and Enter then makes a new line, without sending the form", async () => {
  const sent: string[] = [];
  const { user, field } = setup("", sent);
  await user.type(field, "@sa");
  await options("People");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  await user.keyboard("{Enter}");
  expect(field.value).toBe("@sa\n");
  expect(sent).toEqual([]);
});

test("clicking a suggestion inserts it and keeps typing in the field", async () => {
  const { user, field } = setup();
  await user.type(field, "cc @");
  await user.click((await options("People"))[2] as HTMLElement);
  await user.keyboard("please");
  expect(field.value).toBe("cc @sam please");
});

test("typing # lists issues and pull requests by number or title", async () => {
  const { user, field } = setup();
  await user.type(field, "fixes #1");
  const rows = await options("Issues and pull requests");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.getAttribute("aria-label")).toBe("#12 Daemon forgets the port, closed issue");
  await user.keyboard("{Enter}");
  expect(field.value).toBe("fixes #12 ");
});

test("an email address, a heading and code never open suggestions", async () => {
  const { user, field } = setup();
  await user.type(field, "mail me@mi");
  await user.type(field, "{Enter}# Title{Enter}`@mi");
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(field.value).toBe("mail me@mi\n# Title\n`@mi");
});

test("Enter still continues a list once the person is chosen", async () => {
  const { user, field } = setup();
  await user.type(field, "- ask @mir");
  await options("People");
  await user.keyboard("{Enter}");
  await user.keyboard("{Enter}");
  expect(field.value).toBe("- ask @mira \n- ");
});

function InDialog() {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(true);
  return (
    <TooltipProvider delay={0}>
      <MarkdownCompletionsProvider value={source}>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Edit</DialogTitle>
            <MarkdownEditor label="Description" value={text} onChange={setText} />
          </DialogContent>
        </Dialog>
      </MarkdownCompletionsProvider>
    </TooltipProvider>
  );
}

test("Escape in a dialog closes only the suggestions, then the dialog", async () => {
  const user = userEvent.setup();
  render(<InDialog />);
  await user.type(await screen.findByRole("textbox", { name: "Description" }), "@mi");
  await options("People");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.getByRole("dialog")).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
