import { useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  { login: "bart", name: "Bart Visser" },
  { login: "bob", name: "Bob Ito" },
];
const references = [
  { number: 231, title: "Pull requests page", kind: "pr" as const, state: "open" as const },
  {
    number: 12,
    title: "Daemon forgets the port",
    kind: "issue" as const,
    state: "closed" as const,
  },
  { number: 77, title: "Port bug in the daemon", kind: "issue" as const, state: "open" as const },
];
const source: MarkdownCompletions = {
  people: async (query) =>
    people.filter((p) => p.login.startsWith(query) || p.name.toLowerCase().includes(query)),
  // Like a search that also matches bodies: only the first word has to be in the title.
  references: async (query) =>
    references.filter(
      (r) =>
        String(r.number).startsWith(query) ||
        r.title.toLowerCase().includes(query.split(" ")[0]?.toLowerCase() ?? ""),
    ),
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
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(field.value).toBe("mail me@mi\n# Title\n`@mi");
});

test("# after a deleted @ word never shows people: Enter inserts no one while the search is out", async () => {
  const { user, field } = setup();
  await user.type(field, "@mi");
  await options("People");
  // Same place, other kind; Enter comes before the new search has answered.
  await user.type(field, "{Backspace}{Backspace}{Backspace}#1{Enter}");
  expect(field.value).toBe("#1\n");
});

test("# searches titles by words with spaces between them; Enter takes a row only once one is chosen", async () => {
  const { user, field } = setup();
  await user.type(field, "dupe of #Daemon forg");
  const rows = await options("Issues and pull requests");
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "#12 Daemon forgets the port, closed issue",
  ]);
  // After a phrase, Enter is as likely the end of a sentence: no row is highlighted or named,
  // and Enter makes a new line.
  expect(rows.some((row) => row.getAttribute("aria-selected") === "true")).toBe(false);
  expect(field.hasAttribute("aria-activedescendant")).toBe(false);
  await user.keyboard("{Enter}");
  expect(field.value).toBe("dupe of #Daemon forg\n");
  await user.type(field, "{Backspace}");
  await options("Issues and pull requests");
  await user.keyboard("{ArrowDown}{Enter}");
  expect(field.value).toBe("dupe of #12 ");
});

test("prose after a # closes the list once no title holds every word", async () => {
  const { user, field } = setup();
  await user.type(field, "Tagging this #bug");
  await options("Issues and pull requests");
  await user.type(field, " because it crashes");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  await user.keyboard("{Enter}");
  expect(field.value).toBe("Tagging this #bug because it crashes\n");
});

test("Enter never takes a row from the answer to an earlier, shorter word", async () => {
  const { user, field } = setup();
  await user.type(field, "@b");
  const rows = await options("People");
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "bart, Bart Visser",
    "bob, Bob Ito",
  ]);
  // "o" then Enter before "@bo" has its own answer: no one is inserted.
  await user.type(field, "o{Enter}");
  expect(field.value).toBe("@bo\n");
});

test("picking with the caret inside a word replaces the whole word", async () => {
  const { user, field } = setup("cc @mira please");
  await user.click(field);
  field.setSelectionRange(6, 6);
  await user.keyboard("{Backspace}i");
  expect(field.value).toBe("cc @mira please");
  await options("People");
  await user.keyboard("{Enter}");
  expect(field.value).toBe("cc @mira please");
  expect(field.selectionStart).toBe("cc @mira ".length);
});

test("the list's opening is announced politely", async () => {
  const { user, field } = setup();
  await user.type(field, "@mi");
  await options("People");
  const live = document.querySelector("[aria-live=polite]");
  expect(live?.textContent).toBe("2 people");
  expect(field.getAttribute("aria-autocomplete")).toBe("list");
  // Said once as the list opened, not again as typing narrows it.
  await user.type(field, "r");
  await waitFor(async () => expect(await options("People")).toHaveLength(1));
  expect(live?.textContent).toBe("2 people");
});

test("code never opens suggestions: fences of any kind and indent, indented blocks, and spans", async () => {
  for (const text of [
    "```\n~~~\n@mi",
    "````\n```\n@mi",
    "- item\n    ```\n    @mi",
    "para\n\n    @mi",
    "`` a ` @mi",
    "> ```\n> @mi",
  ]) {
    const { user, field } = setup(text);
    await user.click(field);
    field.setSelectionRange(text.length, text.length);
    await user.keyboard("r");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole("listbox"), text).toBeNull();
    cleanup();
  }
  // An escaped backtick opens no span, a backslash inside a span doesn't keep it open, a list
  // item's indented line is not code, and a fence line inside indented code is that code's
  // text, opening no fence.
  for (const text of ["\\` @mi", "`a\\` @mi", "- item\n\n    @mi", "para\n\n    ```\n\n@mi"]) {
    const { user, field } = setup(text);
    await user.click(field);
    field.setSelectionRange(text.length, text.length);
    await user.keyboard("r");
    expect(await screen.findByRole("listbox"), text).toBeTruthy();
    cleanup();
  }
});

test("a link's #anchor target never opens suggestions", async () => {
  const { user, field } = setup();
  await user.type(field, "see [[setup](#Daemon");
  expect(field.value).toBe("see [setup](#Daemon");
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(screen.queryByRole("listbox")).toBeNull();
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
