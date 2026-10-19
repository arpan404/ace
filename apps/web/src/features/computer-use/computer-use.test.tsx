import { flakyCheckout } from "@ace/fake-daemon";
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

async function openSettings() {
  const app = harness();
  app.play(flakyCheckout()).runThrough("explorer-spawned");
  const world = screenWorld(app.daemon, "thread-checkout");
  return { app, world };
}

const page = () => screen.findByRole("heading", { name: "Computer use", level: 2 });

test("turning computer use on and off is what the daemon records", async () => {
  const { app } = await openSettings();
  await app.open("/settings/computer-use");
  await page();
  const toggle = await screen.findByRole("switch", { name: "Let agents use apps" });

  await userEvent.click(toggle);
  await waitFor(() => expect(app.daemon.screen.enabled).toBe(true));
  await userEvent.click(toggle);
  await waitFor(() => expect(app.daemon.screen.enabled).toBe(false));
});

test("apps the person lists are saved as the apps agents can't use, each once", async () => {
  const { app } = await openSettings();
  await app.open("/settings/computer-use");
  const field = await screen.findByRole("textbox", { name: "Apps agents can't use" });
  await waitFor(() => expect((field as HTMLInputElement).disabled).toBe(false));
  await userEvent.type(field, "Messages, com.apple.mail,, messages{Enter}");
  await waitFor(() =>
    expect(app.daemon.services.settings.get("computer.blockedApps")).toEqual([
      "Messages",
      "com.apple.mail",
    ]),
  );
  expect((field as HTMLInputElement).value).toBe("Messages, com.apple.mail");
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

test("a missing macOS permission offers Request, which asks the daemon's Mac", async () => {
  const { app } = await openSettings();
  app.daemon.screen.permissions.accessibility = false;
  app.daemon.screen.enabled = true;
  await app.open("/settings/computer-use");

  const permissions = await screen.findByRole("region", { name: "macOS permissions" });
  await userEvent.click(within(permissions).getByRole("button", { name: "Grant access" }));

  await waitFor(() => expect(app.daemon.screen.requested).toEqual(["accessibility"]));
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
  await waitFor(() => expect(screen.queryByText("Unavailable")).toBeNull());
  expect(screen.queryByText("Granted", { exact: true })).toBeNull();
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
  await waitFor(() => expect(screen.queryByText("Unavailable")).toBeNull());
  expect(screen.queryByText("Granted", { exact: true })).toBeNull();
});

test("sharing a window starts capture and delegates it to this thread's agent", async () => {
  const { app, world } = await openSettings();
  app.daemon.screen.enabled = true;
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
  expect(await within(panel).findByRole("article", { name: "TextEdit" })).toBeTruthy();
});

test("enabling computer use replaces cached disabled permissions with the helper grants", async () => {
  const { app } = await openSettings();
  await app.open("/settings/computer-use");
  await page();
  const permissions = await screen.findByRole("region", { name: "macOS permissions" });
  await waitFor(() =>
    expect(within(permissions).getAllByRole("button", { name: "Grant access" })).toHaveLength(2),
  );
  await userEvent.click(screen.getByRole("switch", { name: "Let agents use apps" }));
  await waitFor(() =>
    expect(within(permissions).queryByRole("button", { name: "Grant access" })).toBeNull(),
  );
});
