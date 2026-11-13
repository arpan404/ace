import { flakyCheckout } from "@ace/fake-daemon";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { deviceBrowser } from "@/test/device-browser.ts";
import { harness } from "@/test/harness.tsx";
import { screenWorld } from "@/test/screen-world.ts";

// jsdom has no canvas or WebCodecs: the device browser decodes H.264 and records what is drawn.
let browser: ReturnType<typeof deviceBrowser>;
beforeEach(() => {
  browser = deviceBrowser("decodes");
});
afterEach(() => browser.restore());

async function openSettings() {
  const app = harness();
  app.play(flakyCheckout()).runThrough("explorer-spawned");
  const world = screenWorld(app.daemon, "thread-checkout");
  return { app, world };
}

const page = () => screen.findByRole("heading", { name: "Computer use", level: 2 });
const appsSwitch = () => screen.getByRole("switch", { name: "Let agents use apps" });

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

test("the person acts in an agent's app with no take-over, and sees the agent's pointer and that it waits", async () => {
  const { app, world } = await openSettings();
  const sessionId = await world.agentApp("com.apple.TextEdit");
  await app.open("/settings/computer-use");
  const card = await screen.findByRole("article", { name: "TextEdit" });
  await userEvent.click(within(card).getByRole("button", { expanded: false }));
  const live = within(card).getByRole("img", { name: "TextEdit live view" });
  await waitFor(() => expect(browser.draws(live)).toBeGreaterThan(0));

  // The agent clicked a quarter of the way across and halfway down its window.
  app.daemon.screen.agentActivity(sessionId, {
    agentPointer: { x: 97.5, y: 422, kind: "click", at: Date.now() },
  });
  const pointer = await within(card).findByRole("img", { name: /'s pointer$/ });
  expect(pointer.style.left).toBe("25%");
  expect(pointer.style.top).toBe("50%");

  // Shared: the person's key goes straight in, and the agent says it waits for them.
  await waitFor(() => expect(live.getAttribute("tabindex")).toBe("0"));
  fireEvent.keyDown(live, { key: "a" });
  await waitFor(() =>
    expect(app.daemon.screen.inputs).toEqual([
      { sessionId, input: { kind: "text.type", text: "a" } },
    ]),
  );
  await waitFor(() =>
    expect(within(card).getByRole("status").textContent).toMatch(/is waiting for you/),
  );
  expect(within(card).getByRole("button", { name: "Take over" })).toBeTruthy();
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
    expect(within(card).getByRole("status").textContent).toMatch(/is working here/),
  );
  const live = within(card).getByRole("img", { name: "TextEdit live view" });
  await waitFor(() => expect(browser.draws(live)).toBeGreaterThan(0));
  // Each shown picture is acked on the shared stream, naming its session.
  await waitFor(() =>
    expect(app.daemon.screen.acks.at(-1)).toMatchObject({ sessionId, streamId: sessionId }),
  );

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

test("an app's live view asks for 60 fps video and draws it", async () => {
  const { app, world } = await openSettings();
  const sessionId = await world.agentApp("com.apple.TextEdit");
  await app.open("/settings/computer-use");
  const card = await screen.findByRole("article", { name: "TextEdit" });
  await userEvent.click(within(card).getByRole("button", { expanded: false }));

  await waitFor(() =>
    expect(app.daemon.screen.streamRequests.at(-1)).toMatchObject({
      sessionId,
      settings: { codec: "h264", fps: 60 },
    }),
  );
  const live = within(card).getByRole("img", { name: "TextEdit live view" });
  await waitFor(() => expect(browser.events).toContain("drew h264"));
  expect(browser.draws(live)).toBeGreaterThan(0);
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

  expect(browser.videoFrames.length).toBeGreaterThan(0);
  expect(browser.videoFrames.every((frame) => frame.closed)).toBe(true);
});

test("a browser that can't decode H.264 says so instead of showing stills", async () => {
  browser.restore();
  browser = deviceBrowser("none");
  const { app, world } = await openSettings();
  await world.agentApp("com.apple.TextEdit");
  await app.open("/settings/computer-use");
  const card = await screen.findByRole("article", { name: "TextEdit" });
  await userEvent.click(within(card).getByRole("button", { expanded: false }));

  expect(await within(card).findByText("This browser can't decode video")).toBeTruthy();
  const live = within(card).getByRole("img", { name: "TextEdit live view" });
  // The session's stills reach the page, and none is drawn.
  await waitFor(() => expect(app.daemon.screen.acks.length).toBeGreaterThan(0));
  expect(browser.draws(live)).toBe(0);
});

test("granted permissions show their status and let the person open settings to revoke access", async () => {
  const { app } = await openSettings();
  app.daemon.screen.enabled = true;
  await app.open("/settings/computer-use");
  const permissions = await screen.findByRole("region", { name: "Permissions" });
  await waitFor(() =>
    expect(within(permissions).getAllByText("Granted", { exact: true })).toHaveLength(2),
  );
  const revoke = within(permissions).getAllByRole("button", { name: /^Revoke .* access$/ });
  for (const button of revoke) await userEvent.click(button);
  await waitFor(() =>
    expect(app.daemon.screen.requested).toEqual(["screenRecording", "accessibility"]),
  );
  // Opening System Settings does not itself revoke either grant.
  expect(within(permissions).getAllByText("Granted", { exact: true })).toHaveLength(2);
  app.daemon.screen.permissions.accessibility = false;
  await userEvent.click(within(permissions).getByRole("button", { name: "Check again" }));
  expect(await within(permissions).findByText("Not granted", { exact: true })).toBeTruthy();
  expect(within(permissions).getByRole("button", { name: /^Grant .* access$/ })).toBeTruthy();
});

test("a missing macOS permission shows its status and offers to grant access on the daemon's Mac", async () => {
  const { app } = await openSettings();
  app.daemon.screen.permissions.accessibility = false;
  app.daemon.screen.enabled = true;
  await app.open("/settings/computer-use");

  const permissions = await screen.findByRole("region", { name: "Permissions" });
  expect(await within(permissions).findByText("Not granted", { exact: true })).toBeTruthy();
  await userEvent.click(within(permissions).getByRole("button", { name: /^Grant .* access$/ }));

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
  expect(screen.getAllByText("Granted", { exact: true })).toHaveLength(2);
  expect(screen.queryByText("Unavailable")).toBeNull();
  expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
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
  expect(screen.getAllByText("Granted", { exact: true })).toHaveLength(2);
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
  const permissions = await screen.findByRole("region", { name: "Permissions" });
  await waitFor(() =>
    expect(within(permissions).getAllByRole("button", { name: /^Grant .* access$/ })).toHaveLength(
      2,
    ),
  );
  await userEvent.click(screen.getByRole("switch", { name: "Let agents use apps" }));
  await waitFor(() =>
    expect(within(permissions).queryByRole("button", { name: /^Grant .* access$/ })).toBeNull(),
  );
});

test("coming back to Computer use shows apps as still on while the screen channel reconnects", async () => {
  const { app } = await openSettings();
  await app.open("/settings/computer-use");
  await page();
  await userEvent.click(await screen.findByRole("switch", { name: "Let agents use apps" }));
  await waitFor(() => expect(app.daemon.screen.enabled).toBe(true));
  await waitFor(() =>
    expect(
      screen.getByRole("switch", { name: "Let agents use apps" }).getAttribute("aria-checked"),
    ).toBe("true"),
  );

  await userEvent.click(screen.getByRole("link", { name: "General" }));
  await waitFor(() =>
    expect(screen.queryByRole("switch", { name: "Let agents use apps" })).toBeNull(),
  );
  // Record every state the switch shows from the moment the page comes back.
  const seen: (string | null)[] = [];
  const observer = new MutationObserver(() => {
    const toggle = screen.queryByRole("switch", { name: "Let agents use apps" });
    if (toggle) seen.push(toggle.getAttribute("aria-checked"));
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  await userEvent.click(screen.getByRole("link", { name: "Computer use" }));
  await page();
  await waitFor(() => expect(seen.at(-1)).toBe("true"));
  observer.disconnect();
  expect(seen).not.toContain("false");
});

test("once the daemon says apps are off, a dropped channel doesn't bring back the remembered on", async () => {
  const { app } = await openSettings();
  await app.open("/settings/computer-use");
  await page();
  await userEvent.click(await screen.findByRole("switch", { name: "Let agents use apps" }));
  await waitFor(() => expect(appsSwitch().getAttribute("aria-checked")).toBe("true"));

  // Away from Computer use, apps are switched off on the machine.
  await userEvent.click(screen.getByRole("link", { name: "General" }));
  await waitFor(() =>
    expect(screen.queryByRole("switch", { name: "Let agents use apps" })).toBeNull(),
  );
  app.daemon.screen.enable(false);
  await userEvent.click(screen.getByRole("link", { name: "Computer use" }));
  await page();
  await waitFor(() => expect(appsSwitch().getAttribute("aria-checked")).toBe("false"));

  // Every state the switch shows from the moment the channel drops.
  const seen: (string | null)[] = [];
  const observer = new MutationObserver(() => {
    const shown = screen.queryByRole("switch", { name: "Let agents use apps" });
    if (shown) seen.push(shown.getAttribute("aria-checked"));
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  act(() => app.daemon.screen.dropChannels());
  await new Promise((resolve) => setTimeout(resolve, 300));
  observer.disconnect();
  expect(seen).not.toContain("true");
  expect(appsSwitch().getAttribute("aria-checked")).toBe("false");
});

test.each(["linux", "win32"])(
  "%s remote requirements replace macOS settings actions",
  async (platform) => {
    const { app } = await openSettings();
    app.daemon.screen.enabled = true;
    Object.assign(app.daemon.screen.permissions, {
      platform,
      requirements: [
        {
          kind: "desktopSession",
          state: "blocked",
          title: "Desktop session",
          message: "Sign in on the remote machine.",
        },
      ],
    });
    await app.open("/settings/computer-use");
    const permissions = await screen.findByRole("region", { name: "Permissions" });
    expect(await within(permissions).findByText("Sign in on the remote machine.")).toBeTruthy();
    expect(within(permissions).getByText("Needs attention")).toBeTruthy();
    expect(within(permissions).queryByText("Screen Recording")).toBeNull();
    expect(within(permissions).queryByRole("button", { name: /Grant .* access/ })).toBeNull();
  },
);

test("unknown and already satisfied requirements never send a permission request", async () => {
  const { app } = await openSettings();
  app.daemon.screen.enabled = true;
  Object.assign(app.daemon.screen.permissions, {
    platform: "linux",
    requirements: [
      {
        kind: "future",
        state: "blocked",
        title: "Future access",
        message: "Future access instructions",
        action: "Request future access",
        permission: "inputMonitoring",
      },
      {
        kind: "ready",
        state: "ready",
        title: "Ready access",
        message: "Already enabled",
        action: "Enable ready access",
        permission: "accessibility",
      },
      {
        kind: "missing",
        state: "blocked",
        title: "AT-SPI",
        message: "Enable AT-SPI",
        action: "Enable accessibility",
        permission: "accessibility",
      },
    ],
  });
  await app.open("/settings/computer-use");
  const permissions = await screen.findByRole("region", { name: "Permissions" });
  expect(await within(permissions).findByText("Future access instructions")).toBeTruthy();
  expect(within(permissions).queryByRole("button", { name: "Request future access" })).toBeNull();
  expect(within(permissions).queryByRole("button", { name: "Enable ready access" })).toBeNull();
  await userEvent.click(within(permissions).getByRole("button", { name: "Enable accessibility" }));
  await waitFor(() => expect(app.daemon.screen.requested).toEqual(["accessibility"]));
});

test.each(["linux", undefined])(
  "live input on %s retains the host's permission guidance",
  async (platform) => {
    const { app, world } = await openSettings();
    await world.agentApp("com.apple.TextEdit");
    Object.assign(app.daemon.screen.permissions, { platform });
    await app.open("/settings/computer-use");
    const card = await screen.findByRole("article", { name: "TextEdit" });
    await userEvent.click(within(card).getByRole("button", { expanded: false }));
    await userEvent.click(within(card).getByRole("button", { name: "Take over" }));
    expect(await within(card).findByText("You're in control")).toBeTruthy();
    app.daemon.screen.permissions.accessibility = false;
    fireEvent.keyDown(within(card).getByRole("img", { name: "TextEdit live view" }), {
      key: "Enter",
    });
    expect(
      await within(card).findByText(
        platform === "linux"
          ? /^Linux desktop access needs attention/
          : /^macOS hasn't granted a permission/,
      ),
    ).toBeTruthy();
    if (!platform)
      expect(within(card).getByRole("alert").textContent).toContain(
        "Grant Screen Recording and Accessibility to Ace Screen Helper, then try again.",
      );
  },
);

test("share-picker permission failures use the remote Windows platform", async () => {
  const { app } = await openSettings();
  app.daemon.screen.enabled = true;
  Object.assign(app.daemon.screen.permissions, { platform: "win32", screenRecording: false });
  await app.open("/t/thread-checkout");
  await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
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
  expect(await within(dialog).findByText(/Windows desktop access needs attention/)).toBeTruthy();
  expect(within(dialog).queryByText(/macOS hasn't granted/)).toBeNull();
});
