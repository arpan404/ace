import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { DeviceId, SocketTicket } from "@ace/protocol";
import { expect, it } from "vitest";
import { fixture } from "./socket-test-support.ts";
it("the app receives fresh repair evidence and an interactive handoff without storing a thread or command", async () => {
  const f = await fixture({}, (_store, home) => ({
    doctorFix: async (assertAuthorized) => {
      assertAuthorized();
      await writeFile(join(home, "repaired"), "ok");
      return {
        report: {
          at: 2,
          checks: [{ id: "logs.directory", status: "ok", message: "Log folder ready", fix: "" }],
        },
        repairs: [{ id: "logs.directory", status: "fixed", message: "Created log folder" }],
      };
    },
    triageLaunch: async (provider, prompt, _owner, assertAuthorized) => {
      assertAuthorized();
      await writeFile(join(home, "handoff"), JSON.stringify({ provider, prompt }));
      return "interactive-cli";
    },
  }));
  try {
    const client = await f.connect();
    await client.next();
    const head = f.store.headSeq();
    client.send({ type: "diagnostics.request", requestId: "fix", operation: "fix" });
    expect(await client.next()).toMatchObject({
      requestId: "fix",
      report: { at: 2, checks: [{ status: "ok" }] },
      repairs: [{ status: "fixed" }],
    });
    expect(await readFile(join(f.home, "repaired"), "utf8")).toBe("ok");
    client.send({
      type: "diagnostics.request",
      requestId: "launch",
      operation: "launch",
      provider: "cursor",
      prompt: "Investigate reconnects",
    });
    expect(await client.next()).toMatchObject({
      requestId: "launch",
      terminalId: "interactive-cli",
    });
    expect(JSON.parse(await readFile(join(f.home, "handoff"), "utf8"))).toEqual({
      provider: "cursor",
      prompt: "Investigate reconnects",
    });
    expect(f.store.headSeq()).toBe(head);
  } finally {
    await f.close();
  }
});
it("a paired reader can inspect checks but cannot repair or launch a CLI on the host", async () => {
  const f = await fixture({}, (_store, home) => ({
    doctor: async () => ({ at: 1, checks: [] }),
    doctorFix: async () => {
      await writeFile(join(home, "unauthorized"), "fix");
      return { report: { at: 1, checks: [] }, repairs: [] };
    },
    triageLaunch: async () => {
      await writeFile(join(home, "unauthorized"), "launch");
      return "denied";
    },
  }));
  try {
    const paired = f.store.devices.create("Reader", ["read"], 1);
    const ticket = SocketTicket.parse(
      await (
        await fetch(f.server.url.replace("ws:", "http:") + "/v1/tickets", {
          method: "POST",
          headers: { authorization: `Bearer ${paired.token}` },
        })
      ).json(),
    );
    const client = await f.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(paired.device.id),
      ticket: ticket.ticket,
    });
    await client.next();
    client.send({ type: "diagnostics.request", requestId: "read", operation: "doctor" });
    expect(await client.next()).toMatchObject({ requestId: "read", report: { at: 1 } });
    client.send({ type: "diagnostics.request", requestId: "fix", operation: "fix" });
    expect(await client.next()).toMatchObject({ requestId: "fix", error: "forbidden" });
    client.send({
      type: "diagnostics.request",
      requestId: "launch",
      operation: "launch",
      provider: "codex",
      prompt: "Repair ace",
    });
    expect(await client.next()).toMatchObject({ requestId: "launch", error: "forbidden" });
    await expect(access(join(f.home, "unauthorized"))).rejects.toThrow();
  } finally {
    await f.close();
  }
});
