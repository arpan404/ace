import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId, InteractionId, ThreadId, type Interaction } from "@ace/protocol";
import { FakeDaemon, ScenarioPlayer, fakeTransport, uxAudit } from "./index.ts";

/*
 * The fake daemon sends a request too large for its thread as the daemon does (ADR 0156):
 * summarized, readable whole, and answered yes only by a client that read it.
 */

const threadId = ThreadId.parse("thread-ux-large-approval");

async function opened() {
  let now = 0;
  const daemon = new FakeDaemon({ clock: () => ++now });
  const script = uxAudit().find((entry) => entry.thread.id === threadId);
  if (!script) throw new Error("No large approval");
  new ScenarioPlayer(daemon, script).runUntilBlocked();
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("browser"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `large-${++sequence}`,
  });
  await client.start();
  const lease = client.thread(threadId);
  await expect.poll(() => lease.store.interactionIds().length).toBe(1);
  const id = lease.store.interactionIds()[0] ?? "";
  const summary = lease.store.interaction(id);
  if (!summary) throw new Error("No interaction");
  const stored = daemon.interactionOf(threadId, summary.id);
  if (!stored) throw new Error("Not stored");
  return { daemon, client, summary, stored };
}

const allow = (interaction: Interaction, readWhole?: true) => ({
  type: "interaction.resolve" as const,
  interactionId: InteractionId.parse(interaction.id),
  resolution: { kind: "approval" as const, optionId: "allow" },
  ...(readWhole ? { readWhole } : {}),
});

test("a request too large for its thread arrives summarized and reads whole", async () => {
  const f = await opened();
  expect(f.summary.truncated?.chars).toBe(JSON.stringify(f.stored.request).length);
  expect(JSON.stringify(f.summary.request).length).toBeLessThan(64 * 1024);
  expect(await f.client.readInteraction({ threadId, interactionId: f.summary.id })).toEqual(
    f.stored.request,
  );
  await f.client.close();
});

test("allowing a summarized request needs it read whole; denying it doesn't", async () => {
  const f = await opened();
  expect(await f.client.command(allow(f.summary))).toMatchObject({
    ok: false,
    error: "request_not_read",
  });
  expect(f.daemon.interactionOf(threadId, f.summary.id)?.state).toBe("pending");
  expect(await f.client.command(allow(f.summary, true))).toMatchObject({ ok: true });
  expect(f.daemon.interactionOf(threadId, f.summary.id)?.state).toBe("resolved");
  await f.client.close();
});

test("a decline needs no whole read", async () => {
  const f = await opened();
  const deny = {
    ...allow(f.summary),
    resolution: { kind: "approval" as const, optionId: "deny" },
  };
  expect(await f.client.command(deny)).toMatchObject({ ok: true });
  await f.client.close();
});

test("a request the thread doesn't hold can't be read", async () => {
  const f = await opened();
  await expect(
    f.client.readInteraction({ threadId, interactionId: "missing" }),
  ).rejects.toMatchObject({ code: "daemon", message: "interaction_not_found" });
  await f.client.close();
});
