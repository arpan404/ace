import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { chooseSource } from "@/test/model-control.ts";
import { harness } from "@/test/harness.tsx";

// General's lazy body must be transformed before the first interaction's deadline starts.
await import("./general-page.tsx");
configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());

const trigger = () => screen.findByRole("button", { name: /^Titles and commit messages:/ });

test(
  "Generation shows the automatic model, and a picked model is saved on the daemon until Auto",
  { timeout: 30_000 },
  async () => {
    const app = harness();
    const { settings } = app.daemon.services;
    await app.open("/settings/general");
    // Codex is signed in through its accounts, so Auto is GPT-6 Luna.
    await waitFor(async () =>
      expect((await trigger()).getAttribute("aria-label")).toMatch(/Auto · GPT-6 Luna$/),
    );
    await userEvent.click(await trigger());
    const picker = await screen.findByRole("dialog", { name: "Titles and commit messages" });
    await chooseSource(picker, "Claude Code · Personal");
    await userEvent.type(
      within(picker).getByRole("combobox", { name: "Search models" }),
      "Opus 4.8",
    );
    const [opus] = await within(picker).findAllByRole("option", { name: /^Opus 4\.8,/ });
    if (!opus) throw new Error("No Opus 4.8");
    await userEvent.click(opus);
    await waitFor(() =>
      expect(settings.get("generation.model")).toMatchObject({
        provider: "claude",
        model: "claude-opus-4-8",
        instance: "claude-personal",
      }),
    );
    await waitFor(async () =>
      expect((await trigger()).getAttribute("aria-label")).toBe(
        "Titles and commit messages: Opus 4.8",
      ),
    );
    await userEvent.click(await trigger());
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Titles and commit messages" })).getByRole(
        "button",
        { name: "Auto" },
      ),
    );
    await waitFor(() => expect(settings.get("generation.model")).toBeNull());
  },
);

test("turning off auto-draft is saved on the daemon", async () => {
  const app = harness();
  await app.open("/settings/general");
  const toggle = await screen.findByRole("switch", { name: "Auto-draft commit messages" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(toggle);
  await waitFor(() =>
    expect(app.daemon.services.settings.get("generation.autoDraftCommits")).toBe(false),
  );
});
