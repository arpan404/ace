import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import sharp from "sharp";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { devicesToolkit } from "@ace/devices";
import { fakeNode, fakeSimService } from "@ace/devices/testing";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";

const ios = "ios:00000000-0000-4000-8000-00000000F00D";
const person = { kind: "human" as const, owner: "person" };
const button = (name: string, x: number) =>
  fakeNode(`p-${name}`, "Button", name, { x, y: 500, w: 100, h: 40 }, ["press"]);

/**
 * A daemon running the fake devices service, the thread's root agent on MCP, and `ace sim`
 * for the same thread. The daemon closes inside the test: its home goes right after.
 */
async function scenario(run: (h: Awaited<ReturnType<typeof surfaces>>) => Promise<void>) {
  const fake = await fakeSimService();
  const f = await daemonFixture(undefined, { devices: fake.service });
  const credentials = new CredentialRegistry(() => "d".repeat(64));
  try {
    await run(await surfaces(fake, f, credentials));
  } finally {
    credentials.close();
    await f.daemon.close();
    await fake.close();
  }
}
async function surfaces(
  fake: Awaited<ReturnType<typeof fakeSimService>>,
  f: Awaited<ReturnType<typeof daemonFixture>>,
  credentials: CredentialRegistry,
) {
  const home = join(f.h.home, "daemon");
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  devicesToolkit(fake.service).register(registry);
  const lease = credentials.issue(
    { ...f.caller, capabilities: ["devices"] },
    new AbortController().signal,
  );
  const mcp = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await registry.call(name, args, lease.principal, new AbortController().signal);
    const first = result.content[0];
    return first?.type === "text" ? z.unknown().parse(JSON.parse(first.text)) : result.content;
  };
  const sim = async (...words: string[]) => {
    const output = await invoke(home, ["sim", ...words, "--thread", f.caller.threadId]);
    return {
      code: output.code,
      stderr: output.stderr,
      json: z.unknown().parse(JSON.parse(output.stdout)),
    };
  };
  return { ...fake, home, mcp, sim };
}

it("ace sim drives a simulator with the same results, refs and leases as the sim_* tools", () =>
  scenario(async (h) => {
    expect((await h.sim("list")).json).toEqual(await h.mcp("sim_list"));

    const started = await h.sim("start", ios);
    expect(started.code, started.stderr).toBe(0);
    expect(started.json).toMatchObject({
      simId: ios,
      controller: "agent",
      guide: expect.stringContaining("ace sim <verb>"),
    });

    h.platform.screens.set(ios, [button("Continue", 100)]);
    const read = await h.sim("ui", ios);
    expect(read.json).toEqual(await h.mcp("sim_ui", { simId: ios }));
    expect(JSON.stringify(read.json)).toContain('"ref":"@e1"');

    // A ref acts the same from the CLI and from MCP: one agent, one numbering.
    expect((await h.sim("act", ios, "tap", "@e1")).json).toEqual(
      await h.mcp("sim_act", { simId: ios, action: "tap", ref: "@e1" }),
    );
    expect(h.platform.effects).toEqual([`${ios} ui press Continue`, `${ios} ui press Continue`]);

    // The element goes: both report the same stale_ref, and nothing reaches the device.
    h.platform.screens.set(ios, [button("Done", 300)]);
    const stale = await h.sim("act", ios, "tap", "@e1");
    expect(stale.code).toBe(1);
    const failure = z
      .record(z.string(), z.unknown())
      .parse(await h.mcp("sim_act", { simId: ios, action: "tap", ref: "@e1" }));
    expect(stale.json).toEqual({ ok: false, ...failure });
    expect(stale.json).toMatchObject({
      code: "stale_ref",
      detail: expect.stringContaining("Continue"),
    });
    expect(h.platform.effects).toHaveLength(2);

    // A person takes the device: the CLI waits on them (exit 2) and sends nothing.
    await h.service.request({ op: "controller", deviceId: ios, controller: "human" }, person);
    const held = await h.sim("act", ios, "tap", "100", "200");
    expect(held.code).toBe(2);
    expect(held.json).toMatchObject({ ok: false, code: "lease_required" });
    expect(h.platform.effects).toHaveLength(2);
  }));

it("ace sim screenshot writes a JPEG even when no live view runs", () =>
  scenario(async (h) => {
    await h.sim("start", ios);
    await h.sim("stop", ios);
    const out = join(h.home, "screen.jpg");
    const shot = await h.sim("screenshot", ios, "--out", out);
    expect(shot.code, shot.stderr).toBe(0);
    expect(shot.json).toMatchObject({ simId: ios, path: out, width: 300, height: 600, scale: 1 });
    expect(await sharp(await readFile(out)).metadata()).toMatchObject({
      format: "jpeg",
      width: 300,
      height: 600,
    });
    expect(h.platform.shots).toEqual([ios]);
  }));

it("ace sim refuses without a thread and teaches refs first in its help", () =>
  scenario(async (h) => {
    const help = await invoke(h.home, ["sim", "--help"]);
    expect(help.stdout).toContain("Refs first");
    expect(help.stdout).toContain("ace sim act SIM tap @e3");
    const missing = await invoke(h.home, ["sim", "list", "--json"]);
    expect(missing.code).toBe(4);
    expect(missing.stdout).toContain("--thread");
  }));
