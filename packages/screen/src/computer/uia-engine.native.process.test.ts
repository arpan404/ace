/*
 * Real Windows: the CI-built `ace-screen-helper-windows --computer` behind the real client and
 * agent tools, driving owned Win32 fixture windows (`examples/computer_fixture.rs`) on the
 * disposable runner desktop. The fixture reports its own state, so effects are checked without
 * trusting the engine's reading. Run by scripts/vitest-windows-screen.config.ts.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { ComputerClient, ComputerError } from "./client.ts";
import { computerToolkit, type ComputerToolkitOptions } from "./toolkit.ts";
import { ComputerActResult, ComputerHello, ComputerState } from "./wire.ts";

// On a Windows CI runner the helper must be there: a missing build fails instead of skipping.
const ciWindows = process.platform === "win32" && process.env["CI"] === "true";
const windows =
  process.platform === "win32" && (ciWindows || !!process.env["ACE_WINDOWS_SCREEN_HELPER"]);
const helperPath = () => z.string().min(1).parse(process.env["ACE_WINDOWS_SCREEN_HELPER"]);
const fixturePath = () => join(dirname(helperPath()), "examples", "computer_fixture.exe");

const Values = z.object({
  name: z.string(),
  notes: z.string(),
  checked: z.boolean(),
  color: z.string(),
  item: z.number(),
  status: z.string(),
  pressed: z.number(),
  front: z.boolean(),
  clip: z.string(),
  second: z.string(),
  rows: z.array(z.string()),
});
const Line = z.looseObject({
  ready: z.boolean().optional(),
  pid: z.number().optional(),
  front: z.boolean().optional(),
  event: z.string().optional(),
  name: z.string().optional(),
  values: Values.optional(),
});
type Line = z.infer<typeof Line>;

/** Starts a fixture window; it is closed when the test finishes. */
async function fixture(executable: string, args: string[]) {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
  const lines: Line[] = [];
  const waiting = new Set<() => void>();
  createInterface({ input: child.stdout }).on("line", (text) => {
    try {
      lines.push(Line.parse(JSON.parse(text)));
    } catch {
      return;
    }
    for (const notify of waiting) notify();
  });
  child.stdin.on("error", () => {});
  onTestFinished(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  });
  const next = (predicate: (line: Line) => boolean, timeoutMs = 15_000) =>
    new Promise<Line>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(notify);
        reject(
          new Error(
            `The fixture never reported the expected line; it said ${JSON.stringify(lines)}`,
          ),
        );
      }, timeoutMs);
      function notify() {
        const index = lines.findIndex(predicate);
        if (index < 0) return;
        const [line] = lines.splice(index, 1);
        clearTimeout(timer);
        waiting.delete(notify);
        if (line) resolve(line);
      }
      waiting.add(notify);
      notify();
    });
  const ready = await next((line) => line.ready === true);
  const ask = async (command: "values" | "front") => {
    child.stdin.write(`${command}\n`);
    return next((line) =>
      command === "values"
        ? line.values !== undefined
        : line.front !== undefined && line.ready === undefined,
    );
  };
  return {
    pid: ready.pid ?? 0,
    /** Sends a stdin command and waits for the event it reports. */
    command: async (text: string, event: string) => {
      child.stdin.write(`${text}\n`);
      await next((line) => line.event === event);
    },
    /** Resolves on the next event of this kind the fixture reports. */
    reported: (event: string) => next((line) => line.event === event),
    values: async () => Values.parse((await ask("values")).values),
    /** Asks the fixture to take the foreground; true when it has it. */
    front: async () => (await ask("front")).front === true,
    event: (name: string) => next((line) => line.event === "command" && line.name === name),
    pressed: () => next((line) => line.event === "pressed"),
  };
}

/**
 * The real client and toolkit over the CI-built helper, called as an agent would. `person`
 * makes the helper count input other programs synthesize as the person's (test only), so a
 * fixture can stand in for the person.
 */
async function engine(toolkit: ComputerToolkitOptions = {}, options: { person?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-computer-"));
  let next = 0;
  const helpers: ChildProcessWithoutNullStreams[] = [];
  const client = new ComputerClient({
    helper: async () => helperPath(),
    nextId: () => `w${++next}`,
    helperArgs: ["--data-dir", dataDir],
    stopGraceMs: 1_000,
    environment: async () => ({
      ...process.env,
      ...(options.person ? { ACE_COMPUTER_COUNT_INJECTED_INPUT: "1" } : {}),
    }),
    spawnHelper: (command, args, env) => {
      const child = spawn(command, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      helpers.push(child);
      return child;
    },
  });
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  computerToolkit(client, { platform: "windows", ...toolkit }).register(registry);
  const credentials = new CredentialRegistry(() => "b".repeat(64));
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "s",
      threadId: "thread",
      agentId: "root",
      capabilities: ["screen"],
    }),
    new AbortController().signal,
  );
  onTestFinished(async () => {
    client.close();
    credentials.close();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await registry.call(name, args, lease.principal, new AbortController().signal);
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    return { result, text };
  };
  return { client, call, dataDir, helpers };
}

/** Image names of running processes, lower case. */
function isRunning(image: string) {
  return execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"])
    .toString()
    .toLowerCase()
    .includes(image.toLowerCase());
}

function stopImage(image: string) {
  try {
    execFileSync("taskkill", ["/IM", image, "/F"], { stdio: "ignore" });
  } catch {}
}

const app = "computer_fixture.exe";

/** A copy of the fixture under another name, so it is another app to Windows. */
async function copyOfFixture(name: string) {
  const dir = await mkdtemp(join(tmpdir(), "ace-fixture-"));
  const path = join(dir, name);
  await copyFile(fixturePath(), path);
  onTestFinished(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  return path;
}

function node(state: ComputerState, role: string, name: string) {
  const found = state.nodes.find((entry) => entry.role === role && entry.name?.includes(name));
  if (!found) throw new Error(`No ${role} "${name}" in ${JSON.stringify(state.nodes)}`);
  return found.id;
}

describe.runIf(windows)("Windows computer-use engine", () => {
  it("Windows engine answers hello with UI Automation and the step set", async () => {
    const { client } = await engine();
    const hello = ComputerHello.parse(await client.request("hello", {}));
    expect(hello.accessibility).toBe(true);
    expect(hello.capabilities).toEqual(
      expect.arrayContaining(["click", "set_value", "menu", "activate", "cancel"]),
    );
  }, 60_000);

  it("Windows engine acts in a background window by id without taking the person's focus", async () => {
    const target = await fixture(fixturePath(), ["--title", "Ace Target"]);
    const cover = await fixture(await copyOfFixture("cover_fixture.exe"), [
      "--title",
      "Ace Cover",
      "--front",
    ]);
    expect(await cover.front()).toBe(true);
    const { client, call } = await engine();

    const listed = await call("screen_apps", { query: "fixture" });
    expect(listed.text).toContain(`(${app})`);
    const look = await call("screen_state", { app });
    expect(look.text).toContain("in the background");
    expect(look.text).toContain("Press me");
    expect(look.text).toContain("Menu bar: File, Edit");

    const state = ComputerState.parse(await client.request("state", { app }));
    expect(state.app.active).toBe(false);
    const steps = [
      { type: "click", id: node(state, "button", "Press me") },
      { type: "set_value", id: node(state, "text field", "Name"), value: "Ada" },
      {
        type: "select_text",
        id: node(state, "text area", "Notes"),
        text: "gamma",
        cursor: "after",
      },
      { type: "type", id: node(state, "text area", "Notes"), text: " delta" },
      { type: "click", id: node(state, "check box", "Enable feature") },
      { type: "set_value", id: node(state, "combo box", "Color"), value: "Blue" },
      { type: "click", id: node(state, "row", "Two") },
      { type: "menu", path: ["File", "Save"] },
      { type: "key", key: "ctrl+n" },
    ];
    // One step at a time, so a step that brings the window forward is named.
    let acted: ComputerActResult | undefined;
    for (const step of steps) {
      acted = ComputerActResult.parse(await client.request("act", { app, actions: [step] }));
      expect(acted.error, step.type).toBeUndefined();
      expect(acted.done, step.type).toHaveLength(1);
      expect({ step: step.type, front: (await target.values()).front }).toEqual({
        step: step.type,
        front: false,
      });
    }
    await target.pressed();
    await target.event("save");
    await target.event("new");

    const values = await target.values();
    expect(values).toMatchObject({
      name: "Ada",
      notes: "alpha beta gamma delta beta",
      checked: true,
      color: "Blue",
      item: 1,
      pressed: 1,
      front: false,
    });
    expect((await cover.values()).front).toBe(true);
    expect(acted?.state?.nodes.some((entry) => entry.name === "Pressed 1")).toBe(true);
  }, 120_000);

  it("Windows engine refuses input that needs the window in front, then acts after activate", async () => {
    const target = await fixture(fixturePath(), ["--title", "Ace Target"]);
    const cover = await fixture(await copyOfFixture("cover_fixture.exe"), [
      "--title",
      "Ace Cover",
      "--front",
    ]);
    expect(await cover.front()).toBe(true);
    const { client, call } = await engine();

    const pictured = ComputerState.parse(await client.request("state", { app, screenshot: true }));
    expect(pictured.screenshot?.width).toBeGreaterThan(100);
    expect(Buffer.from(pictured.screenshot?.jpeg ?? "", "base64").subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );
    // Reading and capturing never bring the window forward.
    expect((await target.values()).front).toBe(false);

    const shortcut = ComputerActResult.parse(
      await client.request("act", { app, actions: [{ type: "key", key: "ctrl+shift+k" }] }),
    );
    expect(shortcut.error?.code).toBe("window_focus_required");
    expect(shortcut.error?.message).toContain("activate");
    const hover = ComputerActResult.parse(
      await client.request("act", { app, actions: [{ type: "move", x: 20, y: 20 }] }),
    );
    expect(hover.error?.code).toBe("window_focus_required");
    expect((await target.values()).front).toBe(false);

    const field = node(pictured, "text field", "Name");
    const typed = await call("screen_act", {
      app,
      actions: [
        { type: "activate" },
        { type: "click", id: field },
        { type: "key", key: "ctrl+a" },
        { type: "type", text: "Grace" },
        { type: "key", key: "ctrl+s" },
      ],
    });
    expect(typed.result.isError ?? false).toBe(false);
    await target.event("save");
    expect(await target.values()).toMatchObject({ name: "Grace", front: true });
  }, 120_000);

  it("Windows engine launches an executable by path in the background and refuses blocked apps first", async () => {
    // Registered before anything can start them, so a failed check never leaves them running.
    onTestFinished(() => stopImage("launch_fixture.exe"));
    onTestFinished(() => stopImage("blocked_fixture.exe"));
    const path = await copyOfFixture("launch_fixture.exe");
    const { client, call } = await engine({ blockedApps: () => ["blocked_fixture.exe"] });

    const opened = await call("screen_state", { app: path });
    expect(opened.text).toContain("just opened");
    expect(opened.text).toContain("Press me");
    const state = ComputerState.parse(await client.request("state", { app: "launch_fixture.exe" }));
    expect(state.app.active).toBe(false);

    const shell = await call("screen_state", { app: "cmd.exe" });
    expect(shell.result.isError).toBe(true);
    expect(shell.text).toContain("Computer use does not operate this app");
    const listed = await call("screen_state", { app: await copyOfFixture("blocked_fixture.exe") });
    expect(listed.result.isError).toBe(true);
    expect(listed.text).toContain("Apps agents can't use");
    expect(isRunning("blocked_fixture.exe")).toBe(false);
  }, 120_000);

  it("Windows engine starts only windowed apps by path and catches renamed shells", async () => {
    onTestFinished(() => stopImage("tool.exe"));
    onTestFinished(() => stopImage("notes.exe"));
    const { call } = await engine();
    const dir = await mkdtemp(join(tmpdir(), "ace-launch-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
    // The helper itself is a console program.
    const tool = join(dir, "tool.exe");
    await copyFile(helperPath(), tool);
    const consoleTool = await call("screen_state", { app: tool });
    expect(consoleTool.result.isError).toBe(true);
    expect(consoleTool.text).toContain("console program");
    const shell = join(dir, "notes.exe");
    await copyFile(join(z.string().parse(process.env["SystemRoot"]), "System32", "cmd.exe"), shell);
    const renamed = await call("screen_state", { app: shell });
    expect(renamed.result.isError).toBe(true);
    expect(renamed.text).toContain("runs commands");
    expect(isRunning("tool.exe") || isRunning("notes.exe")).toBe(false);
  }, 60_000);

  it("Windows engine stops a cancelled batch and reports the steps it finished", async () => {
    const target = await fixture(fixturePath(), ["--title", "Ace Target"]);
    const { client } = await engine();
    const state = ComputerState.parse(await client.request("state", { app }));
    const controller = new AbortController();
    const running = client.request(
      "act",
      {
        app,
        actions: [
          { type: "click", id: node(state, "button", "Press me") },
          { type: "wait", ms: 10_000 },
        ],
      },
      { signal: controller.signal },
    );
    await target.pressed();
    controller.abort();
    const error = await running.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    if (!(error instanceof ComputerError))
      throw new Error(`Expected a cancellation, got ${String(error)}`);
    expect(error.code).toBe("cancelled");
    expect(ComputerActResult.parse(error.result).done).toHaveLength(1);
  }, 60_000);

  it("Windows engine refuses a stale id once its list row shows other content", async () => {
    const target = await fixture(fixturePath(), ["--title", "Ace Target"]);
    const { client } = await engine();
    const state = ComputerState.parse(await client.request("state", { app }));
    const row = node(state, "row", "Two");
    await target.command("rename", "renamed");
    const acted = ComputerActResult.parse(
      await client.request("act", { app, actions: [{ type: "click", id: row }] }),
    );
    expect(acted.error?.code).toBe("stale_element");
    expect(await target.values()).toMatchObject({ item: -1, rows: ["One", "Zwei", "Three"] });
  }, 60_000);

  it("Windows engine refuses to act behind a modal dialog", async () => {
    const target = await fixture(fixturePath(), ["--title", "Ace Target"]);
    const { client } = await engine();
    const state = ComputerState.parse(await client.request("state", { app, window: "Ace Target" }));
    await target.command("modal", "modal");
    for (const step of [
      { type: "menu", path: ["File", "Save"] },
      { type: "key", key: "ctrl+n" },
      { type: "click", id: node(state, "button", "Press me") },
    ]) {
      const acted = ComputerActResult.parse(
        await client.request("act", { app, window: "Ace Target", actions: [step] }),
      );
      expect(acted.error?.code, step.type).toBe("dialog_open");
      expect(acted.error?.message, step.type).toContain("Ace Modal");
    }
    expect(await target.values()).toMatchObject({ status: "Ready", pressed: 0 });
  }, 60_000);

  it("Windows engine refuses to act while the person used the app just before the batch", async () => {
    const target = await fixture(fixturePath(), ["--title", "Ace Target", "--front"]);
    expect(await target.front()).toBe(true);
    const { client } = await engine({}, { person: true });
    const state = ComputerState.parse(await client.request("state", { app }));
    // The fixture's own synthesized key press stands in for the person typing.
    await target.command("nudge", "nudged");
    const acted = ComputerActResult.parse(
      await client.request("act", {
        app,
        actions: [{ type: "click", id: node(state, "button", "Press me") }],
      }),
    );
    expect(acted.error?.code).toBe("person_active");
    expect((await target.values()).pressed).toBe(0);
  }, 60_000);

  it("Windows engine leaves the foreground with the person once they act during a batch", async () => {
    const target = await fixture(fixturePath(), ["--title", "Ace Target"]);
    const cover = await fixture(await copyOfFixture("cover_fixture.exe"), [
      "--title",
      "Ace Cover",
      "--front",
    ]);
    expect(await cover.front()).toBe(true);
    const { client } = await engine({}, { person: true });
    const state = ComputerState.parse(await client.request("state", { app }));
    const batch = {
      app,
      actions: [
        { type: "click", id: node(state, "button", "Grab focus") },
        { type: "wait", ms: 1_500 },
      ],
    };
    // Without the person: the app took the foreground on its own, and the person's window gets it back.
    const grabbed = target.reported("grabbed");
    ComputerActResult.parse(await client.request("act", batch));
    await grabbed;
    expect((await target.values()).front).toBe(false);
    expect((await cover.values()).front).toBe(true);
    // The person acts while the app is in front: the foreground stays where they left it.
    const again = target.reported("grabbed");
    const acting = client.request("act", batch);
    await again;
    await cover.command("nudge", "nudged");
    ComputerActResult.parse(await acting);
    expect((await target.values()).front).toBe(true);
  }, 90_000);

  it("Windows engine restores the clipboard after a background paste, but not over a copy made meanwhile", async () => {
    const target = await fixture(fixturePath(), ["--title", "Ace Target"]);
    const { client } = await engine();
    const state = ComputerState.parse(await client.request("state", { app }));
    const notes = node(state, "text area", "Notes");
    const paste = (text: string) =>
      client.request("act", {
        app,
        actions: [{ type: "paste", id: notes, text, format: "markdown" }],
      });
    await target.command("clip original", "clip");
    expect(ComputerActResult.parse(await paste("first")).error).toBeUndefined();
    expect(await target.values()).toMatchObject({ clip: "original" });
    expect((await target.values()).notes).toContain("first");

    // The app copies something of its own while pasting: that copy stays.
    await target.command("paste-mode copy", "paste-mode");
    expect(ComputerActResult.parse(await paste("second")).error).toBeUndefined();
    expect(await target.values()).toMatchObject({ clip: "fixture copy" });

    // A paste slower than the message timeout still reads the pasted text, then the person's
    // clipboard comes back.
    await target.command("paste-mode slow", "paste-mode");
    await target.command("clip original", "clip");
    expect(ComputerActResult.parse(await paste("third")).error).toBeUndefined();
    const values = await target.values();
    expect(values.notes).toContain("third");
    expect(values.clip).toBe("original");
  }, 90_000);

  it("Windows engine answers promptly when the app hangs", async () => {
    const target = await fixture(fixturePath(), ["--title", "Ace Target"]);
    const { client } = await engine();
    const state = ComputerState.parse(await client.request("state", { app }));
    await target.command("hang 8000", "hanging");
    const started = Date.now();
    const acted = ComputerActResult.parse(
      await client.request("act", {
        app,
        actions: [{ type: "click", id: node(state, "check box", "Enable feature") }],
      }),
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(acted.error?.code).toBe("app_busy");
    // Let the fixture wake before it is closed.
    expect((await target.values()).checked).toBe(false);
  }, 60_000);

  it("Windows engine keeps typed text out of the app's other windows", async () => {
    const target = await fixture(fixturePath(), ["--title", "Ace Target"]);
    const { client } = await engine();
    await client.request("state", { app, window: "Ace Target" });
    await target.command("second", "second");
    const acted = ComputerActResult.parse(
      await client.request("act", {
        app,
        window: "Ace Target",
        actions: [{ type: "type", text: "stray" }],
      }),
    );
    expect(acted.error?.code).toBe("focus_elsewhere");
    expect(acted.error?.message).toContain("Ace Second");
    expect(await target.values()).toMatchObject({ second: "", name: "" });
  }, 60_000);

  it("Windows helper stops on its own when told to, so it can clean up", async () => {
    const { client, helpers } = await engine();
    ComputerHello.parse(await client.request("hello", {}));
    const [helper] = helpers;
    if (!helper) throw new Error("No helper started");
    const exited = new Promise<number | null>((resolve) =>
      helper.once("exit", (code) => resolve(code)),
    );
    client.close();
    // A clean exit (code 0) rather than a kill: the helper saw stdin close in time.
    expect(await exited).toBe(0);
  }, 30_000);
});
