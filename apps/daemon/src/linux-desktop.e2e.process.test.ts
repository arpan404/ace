/*
 * Linux end to end: the real daemon, the real ace MCP server, ace's pinned Chrome (sandboxed)
 * and the real Linux screen helper, driven by a scripted agent. No provider CLI or model runs.
 * Opt-in only: `apps/daemon/scripts/linux-e2e/run.sh` starts a throwaway desktop and sets
 * `ACE_LINUX_DESKTOP_E2E` to the session it made (wayland, hyprland or headless) and
 * `ACE_SCREEN_HELPER` to the helper it built.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { CallResult, EvalAgent } from "./evals/agent.ts";
import { evalWorld, type EvalWorld } from "./evals/world.ts";
import { answerChooser, scriptedChooser } from "./testing/portal-chooser.ts";

const session = process.env.ACE_LINUX_DESKTOP_E2E;
const helper = process.env.ACE_SCREEN_HELPER;
const enabled = process.platform === "linux" && !!session && !!helper;
/** wayland (GNOME Shell, or KWin in a KDE session) or hyprland (Omarchy's compositor). */
const graphical = ["wayland", "hyprland"].includes(session ?? "");
const exec = promisify(execFile);

/** The desktop's own apps: GNOME's by default, KDE Plasma's when the runner made a KDE session. */
const kde = (process.env.XDG_CURRENT_DESKTOP ?? "").split(":").includes("KDE");
const desktop = kde
  ? {
      calculator: "org.kde.kcalc",
      editor: "org.kde.kwrite",
      keys: ["Seven", "Add", "Eight", "Equals"],
      terminals: ["konsole", "org.kde.konsole"],
      terminal: /konsole/i,
    }
  : {
      calculator: "org.gnome.Calculator",
      editor: "org.gnome.TextEditor",
      keys: ["7", "+", "8", "="],
      terminals: ["xterm", "debian-xterm"],
      terminal: /xterm/i,
    };
const portalDialog = new URL(
  "../../../native/screen-helper-linux/tests/computer/portal_dialog.py",
  import.meta.url,
).pathname;

const worlds: EvalWorld[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function agent(options: {
  browser: boolean;
}): Promise<{ world: EvalWorld; agent: EvalAgent }> {
  const world = await evalWorld({
    browser: options.browser,
    ...(helper ? { screenHelper: helper } : {}),
  });
  worlds.push(world);
  return { world, agent: (await world.agent({ prompt: "check the desktop" })).agent };
}

/** The words a model reads: screenshot data (base64) left out, so digits in it never match. */
const words = (result: CallResult) => result.text.replace(/[A-Za-z0-9+/=]{400,}/g, "<image>");

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The id on the outline line for an element of `role` named exactly `name`. */
function elementId(outline: string, role: string, name?: string): number {
  const pattern = new RegExp(
    `^\\s*(\\d+) ${escaped(role)}${name === undefined ? "\\b" : ` ${escaped(name)}(?:,|$)`}`,
    "m",
  );
  const id = pattern.exec(outline)?.[1];
  if (!id) throw new Error(`No ${role} ${name ?? ""} in the outline:\n${outline}`);
  return Number(id);
}

/** A dev server with a form, a console error and a failing request. */
const consoleError = "e2e: greeting widget failed to load its avatar";
async function devServer(): Promise<string> {
  const page = `<!doctype html><title>Greeter</title>
<script>console.error(${JSON.stringify(consoleError)});</script>
<label>Name <input aria-label="Name" id="name"></label>
<button onclick="document.getElementById('out').textContent = 'Hello, ' + document.getElementById('name').value">Greet</button>
<h1 id="out">Nobody yet</h1>`;
  const server = createServer((request, response) => {
    if (request.url === "/api/avatar") response.writeHead(500).end("seeded failure");
    else response.writeHead(200, { "Content-Type": "text/html" }).end(page);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing dev server address");
  return `http://127.0.0.1:${address.port}/`;
}

/** The ref on the snapshot line naming `name`, e.g. `- button "Greet" [ref=e1-4]`. */
function ref(snapshot: string, name: string): string {
  const line = snapshot.split("\n").find((entry) => entry.includes(`"${name}"`));
  const value = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  if (!value) throw new Error(`No ref for ${name} in:\n${snapshot}`);
  return value;
}

function ok(result: CallResult, what: string): CallResult {
  expect(result.failed, `${what}: ${words(result)}`).toBe(false);
  return result;
}

describe.skipIf(!enabled)(`Linux desktop end to end (${session ?? "off"})`, () => {
  it("an agent opens a dev server page in ace's sandboxed Chrome, fills its form, sees it and its console error", async () => {
    const { world, agent: model } = await agent({ browser: true });
    expect(world.browser, "ace's pinned Chrome (ACE_CHROMIUM_PATH) is required").toBe(true);
    const url = await devServer();
    ok(await model.call("browser_open", { url }), "browser_open");
    const first = words(ok(await model.call("browser_snapshot", {}), "browser_snapshot"));
    expect(first).toContain("Nobody yet");
    const name = ref(first, "Name");
    ok(await model.call("browser_act", { action: "type", ref: name, text: "ace" }), "type");
    ok(await model.call("browser_act", { action: "click", ref: ref(first, "Greet") }), "click");
    ok(await model.call("browser_wait_for", { text: "Hello, ace" }), "wait_for");
    expect(words(ok(await model.call("browser_snapshot", {}), "browser_snapshot"))).toMatch(
      /heading "Hello, ace"/,
    );
    const picture = ok(await model.call("browser_screenshot", {}), "browser_screenshot");
    expect(picture.images).toBe(1);
    expect(words(ok(await model.call("browser_logs", {}), "browser_logs"))).toContain(consoleError);
    // The sandbox ran: the browser started without the opt-out flag.
    const dataDir = dirname(world.daemon.tokenPath);
    const chrome = (await exec("ps", ["-axo", "command"])).stdout
      .split("\n")
      .filter((line) => line.includes(dataDir));
    expect(chrome.length).toBeGreaterThan(0);
    expect(chrome.filter((line) => line.includes("--no-sandbox"))).toEqual([]);
  });

  it.skipIf(graphical)(
    "without a desktop session the daemon still starts and screen tools say no one is logged in",
    async () => {
      expect(process.env.DISPLAY ?? "").toBe("");
      expect(process.env.WAYLAND_DISPLAY ?? "").toBe("");
      const { agent: model } = await agent({ browser: false });
      expect(model.has("screen_state")).toBe(true);
      for (const [tool, args] of [
        ["screen_apps", {}],
        ["screen_state", { app: desktop.calculator }],
      ] as const) {
        const result = await model.call(tool, args);
        expect(result.failed, tool).toBe(true);
        expect(result.text, tool).toContain("No graphical session");
      }
    },
  );

  it.skipIf(!graphical)(
    "an agent finds the desktop's apps by desktop id and never sees a terminal among them",
    async () => {
      const { agent: model } = await agent({ browser: false });
      const apps = words(ok(await model.call("screen_apps", {}), "screen_apps"));
      expect(apps).toContain(desktop.calculator);
      expect(apps).toContain(desktop.editor);
      expect(apps).not.toMatch(desktop.terminal);
      // The desktop's own shell, launcher and services are never offered as apps.
      expect(apps).not.toMatch(/plasmashell|krunner|kded|kwin|gnome-shell|portal/i);
    },
  );

  it.skipIf(!graphical)(
    "an agent types into the background text editor by element id and its next look shows the text",
    async () => {
      const { agent: model } = await agent({ browser: false });
      // Where the chooser is scripted, the person picks the editor's window when asked.
      if (scriptedChooser) await answerChooser({ window: desktop.editor });
      const look = ok(
        await model.call("screen_state", { app: desktop.editor, screenshot: true }),
        "screen_state",
      );
      const outline = words(look);
      // The first look opens the screen-sharing dialog and asks the person to approve it; a
      // remembered approval captures directly. Hyprland sends a window's picture only when its
      // screen redraws, so an idle desktop may have sent none yet: the look says so, and the
      // stream stays open for the next look.
      if (scriptedChooser)
        expect(
          look.images === 1 || /nothing on that screen has redrawn/.test(outline),
          outline,
        ).toBe(true);
      else
        expect(
          look.images === 1 || /No screenshot: .*approve screen sharing/i.test(outline),
          outline,
        ).toBe(true);
      const area = elementId(outline, "text area");
      const typed = "typed by ace in the background";
      ok(
        await model.call("screen_act", {
          app: desktop.editor,
          actions: [{ type: "type", id: area, text: typed }],
          observe: false,
        }),
        "screen_act",
      );
      // Where sharing was approved in the first look, typing redrew the editor, so this look
      // has its picture.
      const pictured = scriptedChooser;
      const next = ok(
        await model.call("screen_state", { app: desktop.editor, screenshot: pictured }),
        "screen_state",
      );
      const after = words(next);
      if (pictured) expect(next.images, after).toBe(1);
      expect(after).toContain("Changes since your last look");
      expect(after).toContain(typed);
    },
  );

  it.skipIf(!graphical)("an agent presses 7 + 8 = in Calculator by ids and reads 15", async () => {
    const { agent: model } = await agent({ browser: false });
    const outline = words(
      ok(await model.call("screen_state", { app: desktop.calculator }), "screen_state"),
    );
    const keys = desktop.keys.map((key) => elementId(outline, "button", key));
    const acted = ok(
      await model.call("screen_act", {
        app: desktop.calculator,
        actions: [
          ...keys.map((id) => ({ type: "click", id })),
          { type: "wait_for", text: "15", timeout_ms: 5_000 },
        ],
      }),
      "screen_act",
    );
    expect(words(acted)).toMatch(/\b15\b/);
  });

  it.skipIf(!graphical)("a terminal is refused before any look or action reaches it", async () => {
    const { agent: model } = await agent({ browser: false });
    for (const app of desktop.terminals) {
      const refused = await model.call("screen_act", {
        app,
        actions: [{ type: "type", text: "touch /tmp/ace-e2e-terminal" }],
      });
      expect(refused.failed, app).toBe(true);
      expect(refused.text, app).toContain("commands");
    }
  });

  it.skipIf(!graphical)(
    "a raw key Wayland can't send is refused with what to do instead",
    async () => {
      const { agent: model } = await agent({ browser: false });
      ok(await model.call("screen_state", { app: desktop.calculator }), "screen_state");
      const refused = await model.call("screen_act", {
        app: desktop.calculator,
        actions: [{ type: "key", key: "Escape" }],
      });
      expect(refused.failed).toBe(true);
      // Wayland gives ace no raw input; the refusal points to element ids.
      expect(refused.text).toMatch(/Wayland/);
      expect(refused.text).toMatch(/element ids/);
    },
  );

  it.skipIf(!kde)(
    "on KDE the person picks the window in KDE's chooser once, and later looks come with a picture",
    async () => {
      const { world, agent: model } = await agent({ browser: false });
      const first = ok(
        await model.call("screen_state", { app: desktop.calculator, screenshot: true }),
        "screen_state",
      );
      expect(first.images).toBe(0);
      expect(words(first)).toMatch(/approve screen sharing for KCalc/);
      // The person picks KCalc in the chooser, leaving "Allow restoring" ticked (test-only:
      // answered through the dialog's accessibility tree, as a click would).
      await exec("python3", [portalDialog, "approve", "KCalc"]);
      const second = ok(
        await model.call("screen_state", { app: desktop.calculator, screenshot: true }),
        "screen_state",
      );
      expect(second.images, words(second)).toBe(1);
      // The approval is kept in ace's data directory, so a restarted helper restores it.
      const token = join(
        dirname(world.daemon.tokenPath),
        "screen",
        "portal",
        "computer-org.kde.kcalc.token",
      );
      expect((await stat(token)).mode & 0o777).toBe(0o600);
    },
  );
});
