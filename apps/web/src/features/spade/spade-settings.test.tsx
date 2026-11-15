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

test("Settings lists Spade's four pages under its own label, and marks only the open one", async () => {
  await spadeApp("/settings/spade/models", withSpade);
  const nav = within(await screen.findByRole("navigation", { name: "Settings pages" }));
  const spade = within(nav.getByRole("region", { name: "Spade" }));
  expect(spade.getAllByRole("link").map((link) => link.textContent)).toEqual([
    "General",
    "Models",
    "Web search",
    "Apps",
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

test("the model for new bots shows once Spade has the setting, and saves the one model picked", async () => {
  const { spade } = await spadeApp("/settings/spade", (api) => {
    withSpade(api);
    api.newBotModel = null;
  });
  const picker = await screen.findByRole("button", { name: "Model for new bots" });
  expect(picker.textContent).toBe("Your first usable model");
  await userEvent.click(picker);
  await userEvent.click(await screen.findByRole("option", { name: /^Sonnet/ }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/settings")).toEqual([
      { new_bot_model: "openrouter/anthropic/sonnet" },
    ]),
  );
  await waitFor(() => expect(picker.textContent).toBe("Sonnet · OpenRouter"));
});

test("a Spade without the setting shows no model for new bots", async () => {
  await spadeApp("/settings/spade", withSpade);
  await screen.findByRole("button", { name: "Fast model" });
  expect(screen.queryByRole("button", { name: "Model for new bots" })).toBeNull();
});

test("each connected app names the bots that use it, and says nothing of them when Spade doesn't", async () => {
  await spadeApp("/settings/spade/apps", (api) => {
    withSpade(api);
    api.connectors.connectors.push(
      {
        id: "github",
        name: "GitHub",
        url: "https://api.githubcopilot.com/mcp/",
        state: "connected",
        bots: ["main", "inbox"],
      },
      { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", state: "connected" },
    );
  });
  const apps = within(await screen.findByRole("region", { name: "Connected apps" }));
  expect(await apps.findByText("Connected · Spade, Inbox")).toBeTruthy();
  expect(apps.getAllByText("Connected")).toHaveLength(1);
});
