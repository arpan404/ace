import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { ScreenManager, framePacket, type Frame } from "@ace/screen";
import { DevicesService, DevicePlatform, agentOwner } from "@ace/devices";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { Agent, McpScope } from "@ace/protocol";
import { DeviceOperation } from "@ace/protocol/devices";
import { startDaemon, readConfig, createDevThread, stubHandler } from "./index.ts";
import { invoke } from "./browser-mcp-test-support.ts";
import { approveForeground } from "./testing/screen-foreground.ts";
import { deviceInputProcess } from "./testing/device-input-process.ts";

const Reply = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(
      z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional() }),
    ),
  }),
});
const Tree = z.object({
  nodes: z.array(z.object({ ref: z.string(), name: z.string(), value: z.string().optional() })),
});

const data = (result: z.infer<typeof Reply>["result"]) =>
  JSON.parse(result.content[0]?.text ?? "null");

it("screen and device agents edit, submit, resume expired leases and respect takeover, disconnect and revocation through daemon MCP", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-computer-journey-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  for (const path of ["platform-tools/adb", "emulator/emulator"]) {
    await mkdir(join(home, path, ".."), { recursive: true });
    await writeFile(join(home, path), "#!/bin/sh\nexit 0\n");
    await chmod(join(home, path), 0o700);
  }
  let id = 0,
    now = 1,
    text = "",
    saved = false,
    sequence = 0;
  let publish: ((frame: Frame) => void) | undefined;
  let stream = "";
  const paint = () => {
    const payload = Buffer.from(`${saved ? "Saved" : "Name"}:${text}`);
    const header = {
      version: 1 as const,
      sessionId: stream,
      sequence: sequence++,
      timestamp: now,
      width: 100,
      height: 200,
      scale: 1,
      codec: "jpeg" as const,
      bytes: payload.length,
    };
    publish?.({ header, payload, packet: framePacket(header, payload) });
  };
  const probe: NonNullable<ConstructorParameters<typeof DevicePlatform>[0]["probe"]> = async (
    _command,
    args,
  ) => {
    const command = args.join(" ");
    let stdout = "";
    if (command === "-list-avds") stdout = "Pixel";
    if (command === "devices -l")
      stdout = "List of devices attached\nemulator-5554 device model:Pixel";
    if (command.endsWith("emu avd name")) stdout = "Pixel\nOK";
    if (command.includes("exec-out cat"))
      stdout = saved
        ? `<hierarchy><node class="android.widget.TextView" text="Saved ${text}" bounds="[0,0][100,100]" /></hierarchy>`
        : '<hierarchy><node class="android.widget.EditText" text="" content-desc="Name" resource-id="name" focusable="true" clickable="true" bounds="[0,0][50,50]"/><node class="android.widget.Button" text="Submit" resource-id="submit" clickable="true" bounds="[50,0][100,50]"/></hierarchy>';
    if (command.includes("'input' 'text'")) {
      text = command.split("'text' '")[1]?.split("'")[0] ?? "";
      paint();
    }
    if (command.includes("'input' 'keyevent' '66'")) {
      saved = true;
      paint();
    }
    return { stdout, stderr: "", code: 0 };
  };
  const platform = new DevicePlatform({
    platform: "linux",
    home,
    env: { ANDROID_HOME: home },
    probe,
    spawn: deviceInputProcess(probe),
  });
  const screen = new ScreenManager({
    command: process.execPath,
    args: [new URL("./testing/agent-screen-helper.ts", import.meta.url).pathname],
    platform: "win32",
    endpoint: `unix:${join(home, "frames.sock")}`,
    nextId: () => `screen-${++id}`,
    recordingDirectory: home,
    publishArtifact: async () => {},
  });
  const devices = new DevicesService({
    platform,
    env: {},
    recordingDirectory: home,
    publishArtifact: async () => {},
    runtime: {
      now: () => now,
      id: () => `device-${++id}`,
      spawn: spawnRawSupervised,
      after: (ms, run) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    },
    capture: async (options) => {
      publish = options.publish;
      stream = options.streamId;
      paint();
      return {
        stop: async () => {
          publish = undefined;
        },
      };
    },
  });
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    screen,
    devices,
    handler: stubHandler(),
    history: { instances: [] },
    modelInstances: [],
  });
  onTestFinished(() => daemon.close());
  const thread = createDevThread(
    daemon.store,
    daemon.store.createWorkspace(home, "Computer journey"),
  );
  daemon.store.appendEvents(thread.id, [
    {
      type: "agent.created",
      agent: Agent.parse({
        id: "root",
        threadId: thread.id,
        parentId: null,
        origin: "root",
        native: { provider: "codex" },
        fidelity: "full",
        cwd: home,
        status: { state: "working", activity: "tool" },
        createdAt: now,
      }),
    },
  ]);
  const scope = McpScope.parse({
    sessionId: "computer-journey",
    threadId: thread.id,
    agentId: "root",
    capabilities: ["screen", "devices"],
  });
  const lease = daemon.mcp.openSession(scope, new AbortController().signal);
  async function call(name: string, args: unknown = {}, failed = false) {
    const result = Reply.parse(
      await (await invoke({ url: daemon.mcp.url, bearer: lease.bearer }, name, args)).json(),
    ).result;
    expect(result.isError === true, JSON.stringify(result)).toBe(failed);
    return result;
  }

  expect((await call("screen_ui_tree", {}, true)).content).toMatchObject([
    { text: "Tool unavailable or capability denied" },
  ]);
  await screen.enable(true);
  await screen.approve("dev.ace.journey", true);
  const session = await screen.start({ kind: "window", windowId: 1, bundleId: "dev.ace.journey" });
  screen.delegateAgent(session.sessionId, scope);
  expect(data(await call("screen_type", { text: "denied" }, true))).toMatchObject({
    code: "foreground_required",
  });
  await approveForeground(daemon, screen, session.sessionId, thread.id);
  expect(
    Tree.parse(data(await call("screen_ui_find", { query: { name: "Name" } }))).nodes[0]?.ref,
  ).toBe("name");
  await call("screen_ui_act", { ref: "name", action: "setValue", value: "journey" });
  await call("screen_type", { text: "!" });
  await call("screen_key", { key: "Enter" });
  expect(Tree.parse(data(await call("screen_ui_tree"))).nodes).toContainEqual(
    expect.objectContaining({ name: "Saved", value: "journey!" }),
  );
  expect(
    Buffer.from((await call("screen_screenshot")).content[0]?.data ?? "", "base64").toString(),
  ).toBe("pixels:Saved journey!");
  expect(data(await call("screen_ui_act", { ref: "name", action: "focus" }, true))).toMatchObject({
    code: "target_gone",
    message: "Native target is no longer available",
    hint: expect.stringContaining("current ref"),
  });
  screen.controller(session.sessionId, "human", "person");
  await call("screen_type", { text: "forbidden" }, true);
  screen.delegateAgent(session.sessionId, scope);
  await approveForeground(daemon, screen, session.sessionId, thread.id);
  await call("screen_scroll", { dx: 0, dy: 10 });
  await call("screen_click", { x: 1, y: 2 });
  await call("screen_screenshot", { threadId: "other" }, true);
  const human = { kind: "human", owner: "person" } as const;
  const request = (operation: unknown) => devices.request(DeviceOperation.parse(operation), human);
  await request({ op: "enable", enabled: true });
  await request({ op: "approve", deviceId: "android:Pixel", threadId: thread.id, allowed: true });
  const delegate = () =>
    request({
      op: "controller",
      deviceId: "android:Pixel",
      controller: "agent",
      threadId: thread.id,
      agentId: "root",
    });
  await delegate();
  expect(data(await call("device_list"))).toMatchObject({ devices: [{ id: "android:Pixel" }] });
  await call("device_boot", { deviceId: "android:Pixel" });
  await call("device_start", { deviceId: "android:Pixel" });
  const deviceRef = Tree.parse(
    data(await call("device_find", { deviceId: "android:Pixel", query: { name: "Name" } })),
  ).nodes[0]?.ref;
  if (!deviceRef) throw new Error("Missing device control");
  await call("device_act", { deviceId: "android:Pixel", ref: deviceRef, action: "focus" });
  await call("device_type", { deviceId: "android:Pixel", text: "journey" });
  await call("device_key", { deviceId: "android:Pixel", key: "enter" });
  expect(
    Tree.parse(data(await call("device_ui_tree", { deviceId: "android:Pixel" }))).nodes,
  ).toContainEqual(expect.objectContaining({ name: "Saved journey" }));
  expect(
    Buffer.from(
      (await call("device_screenshot", { deviceId: "android:Pixel" })).content[0]?.data ?? "",
      "base64",
    ).toString(),
  ).toBe("Saved:journey");
  expect(
    data(
      await call(
        "device_act",
        { deviceId: "android:Pixel", ref: deviceRef, action: "focus" },
        true,
      ),
    ),
  ).toMatchObject({ code: "stale_ref" });
  await request({ op: "controller", deviceId: "android:Pixel", controller: "human" });
  expect(
    data(await call("device_tap", { deviceId: "android:Pixel", x: 1, y: 2 }, true)),
  ).toMatchObject({ code: "lease_required", hint: expect.any(String) });
  await delegate();
  await call("device_tap", { deviceId: "android:Pixel", x: 1, y: 2 });
  now += 30_001;
  await call("device_type", { deviceId: "android:Pixel", text: "late" });
  expect(
    Buffer.from(
      (await call("device_screenshot", { deviceId: "android:Pixel" })).content[0]?.data ?? "",
      "base64",
    ).toString(),
  ).toBe("Saved:late");
  now += 30_001;
  devices.disconnect(agentOwner(scope.threadId, scope.agentId));
  expect(
    data(await call("device_type", { deviceId: "android:Pixel", text: "disconnected" }, true)),
  ).toMatchObject({ code: "lease_required" });
  await delegate();
  await call("device_stop", { deviceId: "android:Pixel" });
  await request({ op: "approve", deviceId: "android:Pixel", threadId: thread.id, allowed: false });
  await call("device_screenshot", { deviceId: "android:Pixel" }, true);
  lease.end();
  expect(
    (await invoke({ url: daemon.mcp.url, bearer: lease.bearer }, "screen_ui_tree", {})).status,
  ).toBe(401);
});
