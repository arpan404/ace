import { workbench } from "@ace/fake-daemon";
import { configure, act, cleanup, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });
async function open() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/settings/prompts");
  await screen.findByRole("list", { name: "Prompt files" });
  return app;
}
test("prompt files list their descriptions and diagnostics, and an edit is saved when reopened", async () => {
  await open();
  const list = screen.getByRole("list", { name: "Prompt files" });
  expect(within(list).getByText("Explain a change in plain language")).toBeTruthy();
  expect(within(list).getByText("Invalid frontmatter")).toBeTruthy();
  expect(within(list).getByRole("button", { name: /unfinished/ })).toBeTruthy();
  await userEvent.click(within(list).getByRole("button", { name: /unfinished/ }));
  const body = await screen.findByRole("textbox", { name: "Prompt content" });
  expect(screen.getByRole("list", { name: "Prompt diagnostics" }).textContent).toContain(
    "Check the names, brackets and indentation.",
  );
  await userEvent.clear(body);
  await userEvent.type(body, "Explain the selected change.");
  await userEvent.click(screen.getByRole("button", { name: "Save prompt" }));
  await screen.findByText("Prompt saved.");
  expect(screen.queryByText("Invalid frontmatter")).toBeNull();
  await userEvent.click(
    within(screen.getByRole("list", { name: "Prompt files" })).getByRole("button", {
      name: /unfinished/,
    }),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: "Prompt content" }) as HTMLTextAreaElement).value,
    ).toBe("Explain the selected change."),
  );
});
test("a new project prompt is created in the chosen project and available from the slash catalog", async () => {
  const app = await open();
  await userEvent.click(screen.getByRole("combobox", { name: "Prompt location" }));
  await userEvent.click(await screen.findByRole("option", { name: "ace" }));
  await userEvent.click(screen.getByRole("button", { name: "+ New prompt" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Prompt file name" }), "branch.md");
  await userEvent.clear(screen.getByRole("textbox", { name: "Prompt content" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Prompt content" }),
    "Explain this branch.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save prompt" }));
  const list = await screen.findByRole("list", { name: "Prompt files" });
  const row = await within(list).findByRole("button", { name: /branch/i });
  expect(row).toBeTruthy();
  cleanup();
  await app.open("/new?project=ace");
  const message = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(message, "Try /branch");
  const menu = await screen.findByRole("listbox", { name: "Commands" });
  const choice = within(menu).getByRole("option", { name: /^Branch Run saved prompt/ });
  expect(within(choice).getByText("Run saved prompt")).toBeTruthy();
  await userEvent.click(choice);
  expect(message.textContent).toBe("Try Branch ");
});
test("a conflicting prompt save explains how to reload and preserves the other edit", async () => {
  const app = await open();
  await userEvent.click(
    within(screen.getByRole("list", { name: "Prompt files" })).getByRole("button", {
      name: /explain/,
    }),
  );
  const body = await screen.findByRole("textbox", { name: "Prompt content" });
  await userEvent.clear(body);
  await userEvent.type(body, "My change");
  act(() =>
    app.daemon.seedServices({
      promptFiles: [
        { name: "explain.md", scope: { kind: "global" }, text: "The other editor's change" },
      ],
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Save prompt" }));
  expect((await screen.findByRole("alert")).textContent).toContain("changed elsewhere");
  await userEvent.click(screen.getByRole("button", { name: "Reload prompt" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: "Prompt content" }) as HTMLTextAreaElement).value,
    ).toBe("The other editor's change"),
  );
});

test("structured prompt edits preserve source metadata when saved and reopened", async () => {
  const app = await open();
  app.daemon.seedServices({
    promptFiles: [
      {
        name: "structured.md",
        scope: { kind: "global" },
        text: "---\n# Keep this comment\nname: review\ndescription: Review changes\nprovider: codex\ncustom: preserved\n---\nRead the diff.\n",
      },
    ],
  });
  // Reopen through the page's public file list after refreshing its query.
  cleanup();
  await app.open("/settings/prompts");
  await userEvent.click(await screen.findByRole("button", { name: "review" }));
  const body = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Prompt content" });
  expect(body.value).toBe("Read the diff.\n");
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Prompt provider" }).value).toBe(
    "codex",
  );
  await userEvent.clear(body);
  await userEvent.type(body, "Read the diff.\nSkip generated files.");
  await userEvent.click(screen.getByRole("button", { name: "Edit source" }));
  expect(body.value).toContain("custom: preserved");
  expect(body.value).toContain("# Keep this comment");
  await userEvent.click(screen.getByRole("button", { name: "Save prompt" }));
  await screen.findByText("Prompt saved.");
  await userEvent.click(screen.getByRole("button", { name: "review" }));
  await waitFor(() =>
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Prompt content" }).value).toBe(
      "Read the diff.\nSkip generated files.",
    ),
  );
});

test("cancelling a dirty prompt can keep the draft or discard it without changing the saved prompt", async () => {
  await open();
  await userEvent.click(screen.getByRole("button", { name: /explain/ }));
  const body = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Prompt content" });
  const saved = body.value;
  await userEvent.clear(body);
  await userEvent.type(body, "Unsaved instructions");
  expect(screen.getByRole("combobox", { name: "Prompt location" }).hasAttribute("disabled")).toBe(
    true,
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  const dialog = await screen.findByRole("dialog", { name: "Discard changes to this prompt?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  expect(body.value).toBe("Unsaved instructions");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(await screen.findByRole("button", { name: "Discard" }));
  await userEvent.click(await screen.findByRole("button", { name: /explain/ }));
  await waitFor(() =>
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Prompt content" }).value).toBe(
      saved,
    ),
  );
});

test("leaving prompt settings asks before discarding an unsaved edit", async () => {
  await open();
  await userEvent.click(screen.getByRole("button", { name: /explain/ }));
  const body = await screen.findByRole("textbox", { name: "Prompt content" });
  await userEvent.clear(body);
  await userEvent.type(body, "Keep this draft");
  await userEvent.click(screen.getByRole("link", { name: "Appearance" }));
  const dialog = await screen.findByRole("dialog", { name: "Discard changes to this prompt?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Prompt content" }).value).toBe(
    "Keep this draft",
  );
  await userEvent.click(screen.getByRole("link", { name: "Appearance" }));
  await userEvent.click(await screen.findByRole("button", { name: "Discard" }));
  expect(await screen.findByRole("radiogroup", { name: "Theme" })).toBeTruthy();
});
