import { workbench } from "@ace/fake-daemon";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
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
  expect(
    within(list).getByText(/settings at the top of this prompt have invalid syntax/),
  ).toBeTruthy();
  expect(within(list).getByRole("button", { name: /unfinished.*Edit/ })).toBeTruthy();
  await userEvent.click(within(list).getByRole("button", { name: /unfinished/ }));
  const body = await screen.findByRole("textbox", { name: "Prompt content" });
  expect(screen.getByRole("list", { name: "Prompt diagnostics" }).textContent).toContain(
    "Check the names, brackets and indentation.",
  );
  await userEvent.clear(body);
  await userEvent.type(body, "Explain the selected change.");
  await userEvent.click(screen.getByRole("button", { name: "Save prompt" }));
  await screen.findByText("Prompt saved.");
  expect(screen.queryByText(/settings at the top of this prompt have invalid syntax/)).toBeNull();
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
  await userEvent.click(screen.getByRole("button", { name: "New prompt" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Prompt file name" }), "branch.md");
  await userEvent.clear(screen.getByRole("textbox", { name: "Prompt content" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Prompt content" }),
    "Explain this branch.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save prompt" }));
  const list = await screen.findByRole("list", { name: "Prompt files" });
  const row = await within(list).findByRole("button", { name: /branch.*Project/ });
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
