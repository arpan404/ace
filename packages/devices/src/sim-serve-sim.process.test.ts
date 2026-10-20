import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { AgentId, ThreadId } from "@ace/protocol";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { DevicesService, devicesToolkit } from "./index.ts";
import { simulatorCapture } from "./simulator-capture.ts";
import { FakeSimPlatform } from "./testing/fake-sim.ts";
import { fakeServeSim } from "./testing/fake-serve-sim.ts";

const ios = "ios:00000000-0000-4000-8000-00000000F00D";

it("on the serve-sim path sim_ui returns refs from its accessibility tree and sim_act taps the element", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-serve-sim-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sim = await fakeServeSim(home, "0.1.48", ios.slice(4));
  // The fake platform's screens are empty: every tree and tap must come from serve-sim.
  const platform = new FakeSimPlatform(home);
  let id = 0;
  const service = new DevicesService({
    platform,
    env: {},
    runtime: {
      now: () => 1,
      id: () => `stream-${++id}`,
      spawn: spawnRawSupervised,
      after(ms, run) {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    },
    capture: (options) =>
      simulatorCapture({ ...options, command: sim.command, env: { PATH: home } }),
    recordingDirectory: home,
    async publishArtifact() {
      throw new Error("Not recording");
    },
  });
  onTestFinished(() => service.close());
  await service.request({ op: "enable", enabled: true }, { kind: "human", owner: "person" });
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  devicesToolkit(service).register(registry);
  const credentials = new CredentialRegistry(() => "c".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    {
      sessionId: "sim-serve-sim",
      threadId: ThreadId.parse("thread-1"),
      agentId: AgentId.parse("agent-1"),
      capabilities: ["devices"],
    },
    new AbortController().signal,
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await registry.call(name, args, lease.principal, new AbortController().signal);
    const first = result.content[0];
    return {
      isError: result.isError === true,
      json: first?.type === "text" ? z.unknown().parse(JSON.parse(first.text)) : undefined,
    };
  };

  expect((await call("sim_start", { simId: ios })).isError).toBe(false);
  const tree = await call("sim_ui", { simId: ios });
  expect(tree.json).toMatchObject({
    nodes: [{ name: "Settings", children: [{ ref: "@e1", role: "Button", name: "General" }] }],
  });
  const acted = await call("sim_act", { simId: ios, action: "tap", ref: "@e1" });
  expect(acted.isError).toBe(false);
  // The row's centre, in serve-sim's normalised touch coordinates.
  await expect.poll(() => sim.hid.length).toBe(2);
  expect(sim.hid).toEqual([
    [3, { type: "begin", x: 0.5, y: 975 / 2622 }],
    [3, { type: "end", x: 0.5, y: 975 / 2622 }],
  ]);
  expect(platform.effects).toEqual([]);
});
