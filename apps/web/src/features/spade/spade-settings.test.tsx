import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const withSpade = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  spade.addAgent({ id: "inbox", name: "Inbox" });
};

test("Settings lists Spade's pages under its own label, and marks only the open one", async () => {
  await spadeApp("/settings/spade/models", withSpade);
  const nav = within(await screen.findByRole("navigation", { name: "Settings pages" }));
  const spade = within(nav.getByRole("region", { name: "Spade" }));
  expect(spade.getAllByRole("link").map((link) => link.textContent)).toEqual([
    "General",
    "Models",
    "Web search",
    "Apps",
    "Security",
  ]);
  await waitFor(() =>
    expect(
      nav
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.textContent),
    ).toEqual(["Models"]),
  );
});

test("the model for new bots names the first usable model and saves the one model picked", async () => {
  const { spade } = await spadeApp("/settings/spade", withSpade);
  const picker = await screen.findByRole("button", { name: "Model for new bots" });
  // The model itself, never "your first usable model".
  await waitFor(() => expect(picker.textContent).toBe("Saved model · OpenRouter"));
  await userEvent.click(picker);
  await userEvent.click(await screen.findByRole("option", { name: /^Sonnet/ }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/settings")).toEqual([
      { new_bot_model: "openrouter/anthropic/sonnet" },
    ]),
  );
  await waitFor(() => expect(picker.textContent).toBe("Sonnet · OpenRouter"));
});

test("each connected app names the bots Spade lets use it, and leaves out a bot narrowed off it", async () => {
  await spadeApp("/settings/spade/apps", (api) => {
    withSpade(api);
    api.connectors.connectors.push(
      {
        id: "github",
        name: "GitHub",
        url: "https://api.githubcopilot.com/mcp/",
        state: "connected",
      },
      { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", state: "connected" },
    );
    api.connectors.access.set("inbox", { all: false, connectors: ["github"] });
  });
  const apps = await screen.findByRole("region", { name: "Connected apps" });
  const line = (app: string) =>
    within(apps).getByText(app).closest("[data-setting-slot]")?.textContent ?? "";
  await waitFor(() => expect(line("GitHub")).toContain("Connected · Spade, Inbox"));
  expect(line("Notion")).toMatch(/Connected · Spade(?!, Inbox)/);
});
