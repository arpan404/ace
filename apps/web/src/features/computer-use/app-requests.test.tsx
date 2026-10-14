import { flakyCheckout, type Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { deviceBrowser } from "@/test/device-browser.ts";
import { harness } from "@/test/harness.tsx";
import { screenWorld } from "@/test/screen-world.ts";

// jsdom has no canvas or image decoding: the device browser records what the live views draw.
let browser: ReturnType<typeof deviceBrowser>;
beforeEach(() => {
  browser = deviceBrowser("none");
});
afterEach(() => browser.restore());

const threadId = "thread-totals";

/** A thread whose agent is working, so it can ask to use an app. */
const working: Scenario = {
  thread: {
    id: threadId,
    workspaceId: "relay",
    title: "Reconcile totals",
    provider: "codex",
    access: "auto-review",
  },
  steps: [
    {
      kind: "facts",
      facts: [
        {
          type: "agent.seen",
          agent: "root",
          origin: "root",
          fidelity: "full",
          native: { provider: "codex", nativeId: "root" },
          cwd: "/Users/dev/relay",
        },
        { type: "turn.started", agent: "root", nativeTurnId: "t1", trigger: "user" },
      ],
    },
  ],
};

test("an agent asking for Safari waits on a card in the thread that asks the person, and Allow once finishes its call", async () => {
  const app = harness();
  app.play(working).runUntilBlocked();
  await app.open(`/t/${threadId}`);
  app.daemon.screen.access.enabled = true;
  let settled = false;
  const asked = app.daemon.screen
    .requestApp("com.apple.Safari", "Check the checkout page", { threadId, agentId: "root" })
    .finally(() => (settled = true));

  const card = await screen.findByRole("article", { name: "Let an agent use Safari" });
  expect(
    within(card).getByRole("heading", { name: "Allow Codex to control Safari?" }),
  ).toBeTruthy();
  // The call waits for the person instead of failing.
  expect(settled).toBe(false);
  await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));

  await asked;
  expect(app.daemon.screen.access.list(threadId).map((grant) => grant.scope)).toEqual(["turn"]);
});

test("Settings › Approved apps adds an open app for every thread and removes it; browsers aren't offered there", async () => {
  const app = harness();
  app.play(flakyCheckout()).runThrough("explorer-spawned");
  const world = screenWorld(app.daemon, "thread-checkout");
  await world.call({ op: "enable", enabled: true });
  await app.open("/settings/computer-use");
  expect(await screen.findByText("No approved apps.")).toBeTruthy();

  await userEvent.click(await screen.findByRole("button", { name: "Add an app" }));
  await userEvent.click(await screen.findByRole("combobox", { name: "App to approve" }));
  expect(screen.queryByRole("option", { name: "Safari" })).toBeNull();
  await userEvent.click(await screen.findByRole("option", { name: "TextEdit" }));
  await userEvent.click(screen.getByRole("button", { name: "Always allow" }));

  await waitFor(() =>
    expect(app.daemon.screen.access.list()).toEqual([
      expect.objectContaining({ bundleId: "com.apple.TextEdit", scope: "always" }),
    ]),
  );
  const grants = await screen.findByRole("list", { name: "Approved apps" });
  await userEvent.click(within(grants).getByRole("button", { name: "Actions for TextEdit" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Revoke" }));
  await waitFor(() => expect(app.daemon.screen.access.list()).toEqual([]));
  expect(await screen.findByText("No approved apps.")).toBeTruthy();
});
