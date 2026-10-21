/*
 * Linux end to end: the real daemon, the real ace MCP server, ace's pinned Chrome (sandboxed)
 * and the real Linux screen helper, driven by a scripted agent. No provider CLI or model runs.
 * Opt-in only: `tools/linux-e2e/run.sh` starts a throwaway desktop and sets
 * `ACE_LINUX_DESKTOP_E2E` to the session it made (x11, wayland or headless) and
 * `ACE_SCREEN_HELPER` to the helper it built.
 */
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { CallResult, EvalAgent } from "./evals/agent.ts";
import { evalWorld, type EvalWorld } from "./evals/world.ts";

const session = process.env.ACE_LINUX_DESKTOP_E2E;
const helper = process.env.ACE_SCREEN_HELPER;
const enabled = process.platform === "linux" && !!session && !!helper;
const graphical = session === "x11" || session === "wayland";
const exec = promisify(execFile);

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
  const world = await evalWorld({ browser: options.browser, screenHelper: helper });
  worlds.push(world);
  return { world, agent: (await world.agent({ prompt: "check the desktop" })).agent };
}

/** The words a model reads: screenshot data (base64) left out, so digits in it never match. */
const words = (result: CallResult) => result.text.replace(/[A-Za-z0-9+/=]{400,}/g, "<image>");

/** The id on the outline line for an element of `role` named exactly `name`. */
function elementId(outline: string, role: string, name?: string): number {
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
        ["screen_state", { app: "org.gnome.Calculator" }],
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
      expect(apps).toContain("org.gnome.Calculator");
      expect(apps).toContain("org.gnome.TextEditor");
      expect(apps).not.toMatch(/xterm/i);
    },
  );

  it.skipIf(!graphical)(
    "an agent types into the background text editor by element id and its next look shows the text",
    async () => {
      const { agent: model } = await agent({ browser: false });
      const look = ok(
        await model.call("screen_state", { app: "org.gnome.TextEditor", screenshot: true }),
        "screen_state",
      );
      const outline = words(look);
      // X11 captures the window; on Wayland the engine either captures or says why it can't.
      if (session === "x11") expect(look.images, outline).toBe(1);
      else
        expect(
          look.images === 1 || /No screenshot: .*(portal|permission)/i.test(outline),
          outline,
        ).toBe(true);
      const area = elementId(outline, "text area");
      const typed = "typed by ace in the background";
      ok(
        await model.call("screen_act", {
          app: "org.gnome.TextEditor",
          actions: [{ type: "type", id: area, text: typed }],
          observe: false,
        }),
        "screen_act",
      );
      const after = words(
        ok(await model.call("screen_state", { app: "org.gnome.TextEditor" }), "screen_state"),
      );
      expect(after).toContain("Changes since your last look");
      expect(after).toContain(typed);
    },
  );

  it.skipIf(!graphical)("an agent presses 7 + 8 = in Calculator by ids and reads 15", async () => {
    const { agent: model } = await agent({ browser: false });
    const outline = words(
      ok(await model.call("screen_state", { app: "org.gnome.Calculator" }), "screen_state"),
    );
    const keys = ["7", "+", "8", "="].map((key) => elementId(outline, "button", key));
    const acted = ok(
      await model.call("screen_act", {
        app: "org.gnome.Calculator",
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
    for (const app of ["xterm", "debian-xterm"]) {
      const refused = await model.call("screen_act", {
        app,
        actions: [{ type: "type", text: "touch /tmp/ace-e2e-terminal" }],
      });
      expect(refused.failed, app).toBe(true);
      expect(refused.text, app).toContain("commands");
    }
  });

  it.skipIf(!graphical)(
    "a raw key for a window in the background is refused with what to do instead",
    async () => {
      const { agent: model } = await agent({ browser: false });
      ok(await model.call("screen_state", { app: "org.gnome.Calculator" }), "screen_state");
      const refused = await model.call("screen_act", {
        app: "org.gnome.Calculator",
        actions: [{ type: "key", key: "Escape" }],
      });
      expect(refused.failed).toBe(true);
      // X11 sends raw input to the front window only; Wayland gives ace no raw input at all.
      expect(refused.text).toMatch(session === "x11" ? /activate/ : /not supported|Wayland/i);
    },
  );
});
