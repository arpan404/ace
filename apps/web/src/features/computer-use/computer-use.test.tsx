import { flakyCheckout } from "@ace/fake-daemon";
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

test("Stop all says it's stopping and takes no second press, then says what it stopped", async () => {
  const { app, world } = await openSettings();
  app.daemon.screen.access.enabled = true;
  await world.agentApp("com.apple.TextEdit");
  await world.agentApp("com.apple.calculator");
  const held = Promise.withResolvers<void>();
  app.daemon.screen.stopAllHold = { until: held.promise };
  await app.open("/settings/computer-use");
  const sessions = await screen.findByRole("list", { name: "Live sessions" });
  await waitFor(() => expect(within(sessions).getAllByRole("article")).toHaveLength(2));

  await userEvent.click(screen.getByRole("button", { name: "Stop all computer use" }));
  const busy = await screen.findByRole("button", { name: "Stopping all computer use…" });
  expect(busy.getAttribute("aria-busy")).toBe("true");
  expect((busy as HTMLButtonElement).disabled).toBe(true);
  expect(app.daemon.screen.access.enabled).toBe(true);

  await act(async () => held.resolve());
  expect(await screen.findByText("Stopped 2 apps. Computer use is off.")).toBeTruthy();
  expect(app.daemon.screen.access.enabled).toBe(false);
});

test("a Stop all the daemon can't finish says why", async () => {
  const { app, world } = await openSettings();
  app.daemon.screen.access.enabled = true;
  await world.agentApp("com.apple.TextEdit");
  app.daemon.screen.stopAllHold = {
    until: Promise.resolve(),
    failure: "1 of 1 app session didn't stop: helper timed out",
  };
  await app.open("/settings/computer-use");
  await screen.findByRole("article", { name: "TextEdit" });

  await userEvent.click(screen.getByRole("button", { name: "Stop all computer use" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Couldn't stop everything: 1 of 1 app session didn't stop: helper timed out",
  );
});

test("secure input says what it is from the session menu, and once allowed, on the card", async () => {
  const { app, world } = await openSettings();
  const sessionId = await world.agentApp("com.apple.TextEdit");
  await app.open("/settings/computer-use");
  const card = await screen.findByRole("article", { name: "TextEdit" });
  await userEvent.click(within(card).getByRole("button", { expanded: false }));

  await userEvent.click(within(card).getByRole("button", { name: "Session options" }));
  const allow = await screen.findByRole("menuitem", { name: /^Allow typing in secure fields/ });
  expect(allow.textContent).toContain("Password fields block agent typing until you allow it");
  await userEvent.click(allow);

  await waitFor(async () =>
    expect(
      (await world.sessions()).find((s) => s.sessionId === sessionId)?.secureInputAllowed,
    ).toBe(true),
  );
  const secure = await within(card).findByRole("group", { name: "Secure input" });
  expect(secure.textContent).toMatch(/password and other secure fields/);
  expect(secure.textContent).toMatch(/stays hidden from it and the log/);
  await userEvent.click(within(secure).getByRole("button", { name: "Turn off" }));
  await waitFor(() =>
    expect(within(card).queryByRole("group", { name: "Secure input" })).toBeNull(),
  );
});

test("an agent's app shows live in the background; taking over and handing back move control on the daemon", async () => {
  const { app, world } = await openSettings();
  const sessionId = await world.agentApp("com.apple.TextEdit");
  await app.open("/settings/computer-use");

  const card = await screen.findByRole("article", { name: "TextEdit" });
  await userEvent.click(within(card).getByRole("button", { expanded: false }));
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
  expect(await within(card).findByText("You're in control")).toBeTruthy();

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
  const row = await screen.findByRole("article", { name: "TextEdit" });
  await userEvent.click(within(row).getByRole("button", { expanded: false }));
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
  expect(within(grants).getByText(/Ask each turn/)).toBeTruthy();

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

test("the profile counts the same live apps as Settings after human takeover", async () => {
  const { app, world } = await openSettings();
  await world.agentApp("com.apple.TextEdit");
  const calculator = await world.agentApp("com.apple.calculator");
  await world.call({ op: "controller", sessionId: calculator, controller: "human" });
  await app.open("/settings/computer-use");
  const sessions = await screen.findByRole("list", { name: "Live sessions" });
  await waitFor(() => expect(within(sessions).getAllByRole("article")).toHaveLength(2));
  expect(await within(sessions).findByText("You're in control")).toBeTruthy();
  const indicator = await screen.findByRole(
    "button",
    { name: "Computer use is active in 2 apps" },
    { timeout: 4000 },
  );
  await userEvent.click(indicator);
  const stops = screen.getAllByRole("button", { name: "Stop Calculator" });
  const stop = stops.at(-1);
  if (!stop) throw new Error("Missing profile Stop");
  await userEvent.click(stop);
  await screen.findByRole("button", { name: "Agents are using 1 app" });
});

test("permissions that can't be read say why and what to do, then show once Check again reads them", async () => {
  const { app } = await openSettings();
  app.daemon.screen.permissionReadFailure = { code: "timeout", message: "Helper didn't answer" };
  await app.open("/settings/computer-use");
  await page();
  await waitFor(() =>
    expect(screen.getByText(/No answer in time\./).parentElement?.textContent).toContain(
      "Check again",
    ),
  );
  expect(screen.getAllByText("Unavailable")).toHaveLength(2);
  expect(screen.queryByText("Checking")).toBeNull();

  app.daemon.screen.permissionReadFailure = undefined;
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.getAllByText("Granted")).toHaveLength(2));
  expect(screen.queryByText("Unavailable")).toBeNull();
  expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
});

test("permissions refused because computer use is off point at turning it on, and read once it is", async () => {
  const { app } = await openSettings();
  // The helper can't be asked while computer use is off (the real daemon fails these reads).
  app.daemon.screen.permissionReadFailure = { code: "internal", message: "Screen request failed" };
  await app.open("/settings/computer-use");
  await page();
  await waitFor(() => expect(screen.getAllByText("Unavailable")).toHaveLength(2));
  expect(screen.getByText(/Screen request failed\./)).toBeTruthy();

  app.daemon.screen.permissionReadFailure = {
    code: "screen_disabled",
    message: "Screen access is disabled",
  };
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() =>
    expect(screen.getByText(/Computer use is off\./).parentElement?.textContent).toContain(
      "Turn on Let agents use apps above.",
    ),
  );
  // The page says it where it happened: no toast pointing back at this same page.
  expect(screen.queryByText("Couldn't read permissions")).toBeNull();

  app.daemon.screen.permissionReadFailure = undefined;
  await userEvent.click(screen.getByRole("switch", { name: "Let agents use apps" }));
  await waitFor(() => expect(screen.getAllByText("Granted")).toHaveLength(2));
});

test("a person grants Safari's native UI for one thread from Computer use, then can revoke it", async () => {
  const { app } = await openSettings();
  app.daemon.screen.access.enabled = true;
  await app.open("/t/thread-checkout");
  await screen.findByRole("heading", { level: 1, name: "Fix flaky checkout test" });
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  await userEvent.click(within(tools).getByRole("button", { name: /^Computer use/ }));
  await userEvent.click(await within(panel).findByRole("button", { name: "Approve an app" }));
  await userEvent.click(await within(panel).findByRole("combobox", { name: "App to approve" }));
  await userEvent.click(await screen.findByRole("option", { name: "Safari" }));
  expect(within(panel).queryByRole("button", { name: /Always/ })).toBeNull();
  await userEvent.click(within(panel).getByRole("button", { name: "Allow for this thread" }));
  await waitFor(() =>
    expect(app.daemon.screen.access.list("thread-checkout")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundleId: "com.apple.Safari",
          scope: "thread",
          threadId: "thread-checkout",
        }),
      ]),
    ),
  );
  await userEvent.click(
    await within(panel).findByRole("button", { name: "Revoke Safari (This thread)" }),
  );
  await waitFor(() => expect(app.daemon.screen.access.list("thread-checkout")).toEqual([]));
});

test("sharing a window grants only this thread, starts capture and delegates to its agent", async () => {
  const { app, world } = await openSettings();
  app.daemon.screen.access.enabled = true;
  await app.open("/t/thread-checkout");
  await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  // Computer use is available through the panel's tool picker.
  if (!within(panel).queryByRole("button", { name: "Share an app or window…" })) {
    await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
    const tools = await within(panel).findByRole("list", { name: "Tools" });
    await userEvent.click(within(tools).getByRole("button", { name: /^Computer use/ }));
  }
  await userEvent.click(
    await within(panel).findByRole("button", { name: "Share an app or window…" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Share an app or window" });
  await userEvent.click(await within(dialog).findByRole("button", { name: "TextEdit · Untitled" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Share with agent" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await world.sessions()).toEqual([expect.objectContaining({ controller: "agent" })]);
  expect(app.daemon.screen.access.list()).toEqual([
    expect.objectContaining({
      bundleId: "com.apple.TextEdit",
      scope: "thread",
      threadId: "thread-checkout",
    }),
  ]);
  expect(await within(panel).findByRole("article", { name: "TextEdit" })).toBeTruthy();
});
