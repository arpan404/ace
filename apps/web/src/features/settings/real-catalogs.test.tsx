import { replayCursor, seedRealCatalogs, workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openModelControl, openModelPicker } from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());
function fixture() {
  const app = harness();
  seedRealCatalogs(app.daemon, Date.now());
  return app;
}

test("a connected source with no enabled models offers Refresh and the working account stays ready", async () => {
  const app = fixture();
  await app.open("/settings/providers/opencode");
  const list = await screen.findByRole("list", { name: "OpenCode services" });
  const copilot = within(list).getByText("GitHub Copilot").closest("li");
  if (!copilot) throw new Error("Missing Copilot row");
  expect(within(copilot).getByText("No models enabled")).toBeTruthy();
  expect(within(copilot).queryByRole("button", { name: /Reconnect|Sign in/ })).toBeNull();
  app.daemon.services.modelSources.set("opencode", [
    {
      source: { kind: "subscription", id: "github-copilot", label: "GitHub Copilot" },
      status: "fresh",
    },
  ]);
  await userEvent.click(within(copilot).getByRole("button", { name: "Refresh" }));
  await within(copilot).findByRole("button", { name: "Disconnect GitHub Copilot" });
  expect(within(copilot).queryByText("No models enabled")).toBeNull();
  const accounts = await screen.findByRole("list", { name: "OpenCode accounts" });
  expect(within(accounts).queryByText("Connection needs attention")).toBeNull();
  expect(screen.queryByRole("region", { name: "Setup" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign in to OpenCode" })).toBeNull();
});

test("an open slash menu receives discovered skills without a reload", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "/");
  expect(screen.queryByRole("option", { name: /clerk/i })).toBeNull();
  seedRealCatalogs(app.daemon, Date.now());
  expect(await screen.findByRole("option", { name: /clerk/i })).toBeTruthy();
});

test("the open Skills library receives discovered skills without a reload", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/skills");
  await screen.findByRole("link", { name: /Test Driven Development/ });
  expect(screen.queryByRole("link", { name: /clerk/i })).toBeNull();
  seedRealCatalogs(app.daemon, Date.now());
  expect(await screen.findByRole("link", { name: /clerk/i })).toBeTruthy();
});

test("Usage combines legacy bare and prefixed model ids and labels the Codex weekly quota", async () => {
  await fixture().open("/accounts");
  const table = await screen.findByRole("table", { name: "Usage by model" });
  await waitFor(() =>
    expect(within(table).getAllByRole("cell", { name: "Muse Spark 1.3 Contributor" })).toHaveLength(
      1,
    ),
  );
  expect(within(table).getByRole("cell", { name: "2.8M" })).toBeTruthy();
  expect(screen.queryByText("On subscriptions")).toBeNull();
  expect((await screen.findAllByText("Weekly")).length).toBeGreaterThan(0);
  expect(screen.queryByText(/5-hour 7%/)).toBeNull();
});

test("Pi's service chooser marks ChatGPT connected with its provider icon", async () => {
  await fixture().open("/settings/providers/pi");
  await userEvent.click(await screen.findByRole("button", { name: "Connect a service" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Pi" });
  const choice = await within(dialog).findByRole("button", { name: "ChatGPT / Codex" });
  expect(within(choice).getByText("Connected")).toBeTruthy();
  expect(within(choice).getByRole("img", { name: "ChatGPT / Codex" })).toBeTruthy();
  expect(within(dialog).queryByText("openai-codex")).toBeNull();
});

test("favourites retain the opus alias and OpenCode shows free and local models without raw preview tags", async () => {
  const app = fixture();
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  const popover = await openModelControl(/^Model: Opus 5\.5, Personal/);
  const list = await openModelPicker(popover);
  await userEvent.click(within(popover).getByRole("tab", { name: "Favorites" }));
  expect(within(list).getByRole("option", { name: /Opus 5.5/ })).toBeTruthy();
  await userEvent.click(
    within(list).getByRole("button", { name: "Remove Opus 5.5 from favorites" }),
  );
  await waitFor(() => expect(within(list).queryByRole("option", { name: /Opus 5.5/ })).toBeNull());
  await userEvent.click(within(popover).getByRole("tab", { name: /OpenCode.*Your CLI login/ }));
  expect(within(list).getByRole("group", { name: "OpenCode Zen" })).toBeTruthy();
  expect(within(list).getByRole("option", { name: /Big Pickle.*free/i })).toBeTruthy();
  expect(within(list).getByRole("option", { name: /Qwen3 Coder.*LM Studio/ })).toBeTruthy();
  expect(within(list).queryByText("preview-free")).toBeNull();
  expect(within(popover).queryByRole("button", { name: "Sign in" })).toBeNull();
});
