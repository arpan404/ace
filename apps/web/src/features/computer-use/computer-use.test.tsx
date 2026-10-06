import { flakyCheckout } from "@ace/fake-daemon";
import type { ScreenState } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
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

async function openSettings() {
  const app = harness();
  app.play(flakyCheckout()).runThrough("explorer-spawned");
  const world = screenWorld(app.daemon, "thread-checkout");
  return { app, world };
}

const page = () => screen.findByRole("heading", { name: "Computer use", level: 2 });

test("turning computer use on is what the daemon records, and Stop all turns it off and ends every session", async () => {
  const { app, world } = await openSettings();
  await app.open("/settings/computer-use");
  await page();

  await userEvent.click(await screen.findByRole("switch", { name: "Let agents use apps" }));
  await waitFor(() => expect(app.daemon.screen.access.enabled).toBe(true));

  await world.agentApp("com.apple.TextEdit");
  await world.agentApp("com.apple.calculator");
  const sessions = await screen.findByRole("list", { name: "Live sessions" });
  await waitFor(() => expect(within(sessions).getAllByRole("article")).toHaveLength(2));

  await userEvent.click(screen.getAllByRole("button", { name: "Stop all computer use" })[0]!);

  await waitFor(() => expect(app.daemon.screen.access.enabled).toBe(false));
  expect(await world.sessions()).toEqual([]);
  expect(await screen.findByText("No app is being used.")).toBeTruthy();
  expect(
    (screen.getByRole("switch", { name: "Let agents use apps" }) as HTMLElement).getAttribute(
      "aria-checked",
    ),
  ).toBe("false");
});

test("an agent's app shows live in the background; taking over and handing back move control on the daemon", async () => {
  const { app, world } = await openSettings();
  const sessionId = await world.agentApp("com.apple.TextEdit");
  await app.open("/settings/computer-use");

  const card = await screen.findByRole("article", { name: "TextEdit" });
  expect(within(card).getByText("Background")).toBeTruthy();
  expect(within(card).getByText("Capturing")).toBeTruthy();
  await waitFor(() =>
    expect(within(card).getByRole("status").textContent).toMatch(/is in control/),
  );
  const live = within(card).getByRole("img", { name: "TextEdit live view" });
  await waitFor(() => expect(browser.draws(live)).toBeGreaterThan(0));

  await userEvent.click(within(card).getByRole("button", { name: "Take over" }));
  await waitFor(async () =>
    expect((await world.sessions()).find((s) => s.sessionId === sessionId)?.controller).toBe(
      "human",
    ),
  );
  expect(await within(card).findByText("You are in control")).toBeTruthy();

  await userEvent.click(within(card).getByRole("button", { name: "Hand back" }));
  await waitFor(async () =>
    expect((await world.sessions()).find((s) => s.sessionId === sessionId)?.controller).toBe(
      "agent",
    ),
  );
});

test("leaving the page closes the live view's decoded frames", async () => {
  const { app, world } = await openSettings();
  await world.agentApp("com.apple.TextEdit");
  const view = await app.open("/settings/computer-use");
  const live = await screen.findByRole("img", { name: "TextEdit live view" });
  await waitFor(() => expect(browser.draws(live)).toBeGreaterThan(0));

  view.unmount();

  expect(browser.bitmaps.length).toBeGreaterThan(0);
  expect(browser.bitmaps.every((bitmap) => bitmap.closed)).toBe(true);
});

test("revoking an approved app removes the daemon's grant; a sensitive app says it asks every turn", async () => {
  const { app, world } = await openSettings();
  await world.call({ op: "enable", enabled: true });
  await world.call({
    op: "approve",
    bundleId: "com.apple.TextEdit",
    allowed: true,
    scope: "always",
  });
  await world.call({
    op: "approve",
    bundleId: "com.apple.systempreferences",
    allowed: true,
    scope: "always",
  });
  await app.open("/settings/computer-use");

  const grants = await screen.findByRole("list", { name: "Approved apps" });
  expect(within(grants).getByText(/Always · asks every turn/)).toBeTruthy();

  await userEvent.click(within(grants).getByRole("button", { name: "Revoke TextEdit (Always)" }));

  await waitFor(() =>
    expect(app.daemon.screen.access.list().map((grant) => grant.bundleId)).toEqual([
      "com.apple.systempreferences",
    ]),
  );
  await waitFor(() => expect(within(grants).queryByText("TextEdit")).toBeNull());
});

test("a missing macOS permission offers Request, which asks the daemon's Mac", async () => {
  const { app } = await openSettings();
  app.daemon.screen.permissions.accessibility = false;
  await app.open("/settings/computer-use");

  const permissions = await screen.findByRole("region", { name: "macOS permissions" });
  await waitFor(() => expect(within(permissions).getByText("Not granted")).toBeTruthy());
  await userEvent.click(within(permissions).getByRole("button", { name: "Request" }));

  await waitFor(() => expect(app.daemon.screen.requested).toEqual(["accessibility"]));
});

test("the rail shows quietly while an agent uses an app, and stopping it there ends the session", async () => {
  const { app, world } = await openSettings();
  await app.open("/t/thread-checkout");
  expect(screen.queryByRole("button", { name: /Agents are using/ })).toBeNull();

  await world.agentApp("com.apple.calculator");

  // It mounts once the app is idle after its first paint (two seconds in jsdom).
  const indicator = await screen.findByRole(
    "button",
    { name: "Agents are using 1 app" },
    { timeout: 4000 },
  );
  await userEvent.click(indicator);
  await userEvent.click(await screen.findByRole("button", { name: "Stop Calculator" }));

  await waitFor(async () => expect(await world.sessions()).toEqual([]));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /Agents are using/ })).toBeNull(),
  );
});

test("while a stop waits on the helper, the rail keeps showing capture until the daemon confirms it ended", async () => {
  const { app, world } = await openSettings();
  const sessionId = await world.agentApp("com.apple.TextEdit");
  await app.open("/t/thread-checkout");
  await screen.findByRole("button", { name: "Agents are using 1 app" }, { timeout: 4000 });
  const [live] = (await world.sessions()) as unknown as ScreenState[];
  // The daemon's broadcasts while the native stop is held: the agent is released, capture is not.
  const broadcast = (state: ScreenState) =>
    act(() =>
      Reflect.apply(
        Reflect.get(app.daemon.screen, "push") as (m: unknown) => void,
        app.daemon.screen,
        [{ type: "screen.state", state }],
      ),
    );
  broadcast({
    ...live!,
    sessionId,
    lifecycle: "stopping",
    controller: "none",
    holder: undefined,
    indicator: true,
  });

  const indicator = await screen.findByRole("button", {
    name: "Computer use is active in 1 app",
  });
  await userEvent.click(indicator);
  expect(await screen.findByText(/Stopping · capturing/)).toBeTruthy();

  // Acknowledged: capture is off and the session has ended.
  broadcast({
    ...live!,
    sessionId,
    lifecycle: "stopped",
    controller: "none",
    holder: undefined,
    indicator: false,
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /Agents are using|Computer use is active/ }),
    ).toBeNull(),
  );
});
