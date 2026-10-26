/*
 * Real Windows: the CI-built `ace-screen-helper-windows --computer` behind the real client and
 * agent tools, driving owned Win32 fixture windows (`examples/computer_fixture.rs`) on the
 * disposable runner desktop. The fixture reports its own state, so effects are checked without
 * trusting the engine's reading. Run by scripts/vitest-windows-screen.config.ts.
 */
import { spawn } from "node:child_process";
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

const windows = process.platform === "win32" && !!process.env["ACE_WINDOWS_SCREEN_HELPER"];
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
    values: async () => Values.parse((await ask("values")).values),
    /** Asks the fixture to take the foreground; true when it has it. */
    front: async () => (await ask("front")).front === true,
    event: (name: string) => next((line) => line.event === "command" && line.name === name),
    pressed: () => next((line) => line.event === "pressed"),
  };
}

/** The real client and toolkit over the CI-built helper, called as an agent would. */
async function engine(toolkit: ComputerToolkitOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-computer-"));
  let next = 0;
  const client = new ComputerClient({
    helper: async () => helperPath(),
    nextId: () => `w${++next}`,
    helperArgs: ["--data-dir", dataDir],
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
  return { client, call, dataDir };
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
    const acted = ComputerActResult.parse(await client.request("act", { app, actions: steps }));
    expect(acted.error).toBeUndefined();
    expect(acted.done).toHaveLength(steps.length);
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
    expect(acted.state?.nodes.some((entry) => entry.name === "Pressed 1")).toBe(true);
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
    const path = await copyOfFixture("launch_fixture.exe");
    const { client, call } = await engine({ blockedApps: () => ["cover_fixture.exe"] });

    const opened = await call("screen_state", { app: path });
    expect(opened.text).toContain("just opened");
    expect(opened.text).toContain("Press me");
    const state = ComputerState.parse(await client.request("state", { app: "launch_fixture.exe" }));
    onTestFinished(() => {
      try {
        process.kill(state.app.pid);
      } catch {}
    });
    expect(state.app.active).toBe(false);

    const shell = await call("screen_state", { app: "cmd.exe" });
    expect(shell.result.isError).toBe(true);
    expect(shell.text).toContain("Computer use does not operate this app");
    const listed = await call("screen_state", { app: await copyOfFixture("cover_fixture.exe") });
    expect(listed.result.isError).toBe(true);
    expect(listed.text).toContain("Apps agents can't use");
  }, 120_000);

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
});
