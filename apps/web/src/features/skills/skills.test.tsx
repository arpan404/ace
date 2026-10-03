import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

const catalog = () => screen.getByRole("navigation", { name: "Skills catalog" });

test("Skills opens on the first skill and lists skills, plugins and slash commands", async () => {
  await harness().open("/skills");

  expect(await screen.findByRole("heading", { level: 1, name: "code-review" })).toBeTruthy();
  expect(screen.getByText("repo · .claude/skills")).toBeTruthy();
  expect(screen.getByText(/Review the changes since a fixed point/)).toBeTruthy();
  const sections = within(catalog())
    .getAllByRole("region")
    .map((region) => region.getAttribute("aria-label"));
  expect(sections).toEqual(["Skills", "Plugins", "Slash commands"]);
});

test("searching and filtering by source narrow the catalog", async () => {
  await harness().open("/skills/code-review");
  await screen.findByRole("navigation", { name: "Skills catalog" });

  await userEvent.type(screen.getByRole("searchbox", { name: "Search skills" }), "PR");
  await waitFor(() => expect(within(catalog()).queryByText("tdd")).toBeNull());
  expect(within(catalog()).getByText("/pr-desc")).toBeTruthy();
  expect(within(catalog()).getByText("GitHub")).toBeTruthy();

  await userEvent.clear(screen.getByRole("searchbox", { name: "Search skills" }));
  await userEvent.click(screen.getByRole("button", { name: "Source: All sources" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Your home folder" }));
  await waitFor(() => expect(within(catalog()).queryByText("code-review")).toBeNull());
  expect(within(catalog()).getByText("diagnosing-bugs")).toBeTruthy();
  expect(within(catalog()).getByText("release-notes")).toBeTruthy();
});

test("turning a skill off marks it off in the catalog", async () => {
  await harness().open("/skills/tdd");
  const enabled = await screen.findByRole("switch", { name: "Enabled" });
  expect(enabled.getAttribute("aria-checked")).toBe("true");

  await userEvent.click(enabled);

  await waitFor(() =>
    expect(screen.getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe(
      "false",
    ),
  );
  const row = within(catalog()).getByRole("link", { name: /tdd/ });
  expect(row.textContent).toContain("off");
});

test("changing where a skill is available updates its detail", async () => {
  await harness().open("/skills/code-review");
  await screen.findByRole("heading", { level: 1, name: "code-review" });

  await userEvent.click(screen.getByRole("button", { name: "Change" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Codex only" }));

  expect(await screen.findByText("Codex only.")).toBeTruthy();
});

test("installing a plugin adds it to Plugins and opens it", async () => {
  await harness().open("/skills/code-review");
  await screen.findByRole("heading", { level: 1, name: "code-review" });

  await userEvent.click(screen.getByRole("button", { name: "Add skill or plugin" }));
  const dialog = await screen.findByRole("dialog", { name: "Install a plugin" });
  await userEvent.type(within(dialog).getByLabelText("Repository"), "not a repo");
  await userEvent.click(within(dialog).getByRole("button", { name: "Install" }));
  expect(within(dialog).getByRole("alert").textContent).toContain("owner/name");

  await userEvent.clear(within(dialog).getByLabelText("Repository"));
  await userEvent.type(within(dialog).getByLabelText("Repository"), "linear/linear-mcp");
  await userEvent.click(within(dialog).getByRole("button", { name: "Install" }));

  expect(await screen.findByRole("heading", { level: 1, name: "linear-mcp" })).toBeTruthy();
  const plugins = within(catalog()).getByRole("region", { name: "Plugins" });
  expect(within(plugins).getByText("linear-mcp")).toBeTruthy();
});

test("Edit source opens the skill's file in the default editor", async () => {
  const launched = vi.spyOn(window, "open").mockImplementation(() => null);
  await harness().open("/skills/code-review");
  await userEvent.click(await screen.findByRole("button", { name: "Edit source" }));
  expect(await screen.findByText("Opened code-review in Visual Studio Code")).toBeTruthy();
  expect(launched).toHaveBeenCalledWith(
    "vscode://file/Users/dev/ace/.claude/skills/code-review/SKILL.md",
    "_self",
  );
  launched.mockRestore();
});
