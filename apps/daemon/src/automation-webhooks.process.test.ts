import { existsSync, readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readConfig } from "@ace/daemon";
import { webhookKeyName } from "./automation-webhook-key.ts";
import { signWebhook } from "@ace/automations";
import {
  AgentControlOperation,
  Automation,
  ThreadId,
  type AutomationWebhookResponse,
} from "@ace/protocol";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { connectAutomations } from "./automation-socket-test-support.ts";
import { answer, personCommand } from "./automation-one-thread-test-support.ts";

// Webhook automations (ADR 0173) on a real daemon: the person's socket, the automation store on
// disk, a restart, and the handler ace's relay forwards `/m/<hostId>/hooks/…` to. ace cloud's
// own forwarding is covered under real workerd in apps/cloud/src/http.process.test.ts.

const wait = { timeout: 15_000 };
const forwarded = { origin: "https://cloud.example", prefix: "/m/host-1" };

async function setUp() {
  const f = await daemonFixture();
  const app = await connectAutomations(f, "webhook-person");
  await f.daemon.settings.set("automations.enabled", true, { kind: "global" });
  const automation = Automation.parse({
    id: "deploy-check",
    title: "Deploy check",
    enabled: true,
    workspace: f.h.home,
    provider: "claude",
    prompt: "Check the {{body.env}} deploy",
    worktree: false,
    trigger: { kind: "webhook" },
    missedRun: "skip",
    concurrency: 1,
    jitterMs: 0,
  });
  expect(
    await app.ask({
      type: "automation.put",
      requestId: "create",
      automation,
      expectedRevision: null,
    }),
  ).toMatchObject({ ok: true });
  const webhook = async (action: "rotate" | "revoke", requestId: string) => {
    app.client.send({ type: "automation.webhook", requestId, id: automation.id, action });
    for (;;) {
      const response = await app.client.next();
      if (response.type === "automation.webhookResult" && response.requestId === requestId)
        return response as AutomationWebhookResponse;
    }
  };
  const listed = () => app.ask({ type: "automation.list", requestId: "list" });
  const runs = async () =>
    (
      await app.ask({
        type: "automation.inbox",
        requestId: "history",
        automationId: automation.id,
        limit: 50,
      })
    ).inbox?.runs ?? [];
  return { f, app, automation, webhook, listed, runs };
}

type Daemon = Awaited<ReturnType<typeof daemonFixture>>["daemon"];
function deliver(
  daemon: Daemon,
  now: () => number,
  hookId: string,
  secret: string,
  options: { id?: string; body?: unknown } = {},
) {
  const id = options.id ?? "evt_1";
  const seconds = Math.floor(now() / 1000);
  const payload = new TextEncoder().encode(JSON.stringify(options.body ?? { env: "prod" }));
  const handler = daemon.automationWebhooks;
  if (!handler) throw new Error("No webhook service");
  return handler.relay(
    new Request(`${forwarded.origin}${forwarded.prefix}/hooks/${hookId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(seconds),
        "webhook-signature": signWebhook(secret, id, seconds, payload),
      },
      body: payload,
    }),
    new AbortController().signal,
    forwarded,
  );
}

test("a signed webhook starts one run, a retry before or after a restart starts none, and the secret stays private", async () => {
  const { f, app, webhook, listed, runs } = await setUp();
  let daemon = f.daemon;
  try {
    // No secret yet: nothing answers, and the list says so.
    expect((await listed()).schedules?.[0]?.webhook).toEqual({
      active: false,
      path: null,
      url: null,
      urls: [],
    });

    // Agents can't make or read a secret: their automation tool has no such request.
    const fromAgent = AgentControlOperation.safeParse({
      op: "automation.manage",
      request: {
        type: "automation.webhook",
        requestId: "agent",
        id: "deploy-check",
        action: "rotate",
      },
    });
    expect(fromAgent.success).toBe(false);

    const made = await webhook("rotate", "rotate-1");
    expect(made).toMatchObject({ ok: true, webhook: { active: true, url: null } });
    const hookId = hookIdOf(made);
    const secret = made.secret ?? "";
    expect(secret).toMatch(/^whsec_/);

    // remote.relayWebhooks is off, so even a signed request is refused.
    expect((await deliver(daemon, () => f.h.clock.now(), hookId, secret)).status).toBe(404);
    await daemon.settings.set("remote.relayWebhooks", true, { kind: "global" });
    await expect.poll(() => daemon.automationWebhooks?.enabled("relay"), wait).toBe(true);
    // On, but this test machine isn't registered on ace's relay, so the list says why.
    expect(daemon.automationWebhooks?.state("deploy-check")).toMatchObject({
      active: true,
      url: null,
      problem: expect.any(String),
    });

    const first = await deliver(daemon, () => f.h.clock.now(), hookId, secret);
    expect(first.status).toBe(202);
    const { runId } = (await first.json()) as { runId: string };
    await expect.poll(async () => (await runs()).length, wait).toBe(1);
    expect((await runs())[0]).toMatchObject({ id: runId, trigger: "webhook" });
    await expect
      .poll(() => JSON.stringify([...f.h.inputs.values()]), wait)
      .toContain("Check the prod deploy");

    // The same delivery again, then after a restart: the same run, never a second.
    expect(await (await deliver(daemon, () => f.h.clock.now(), hookId, secret)).json()).toEqual({
      runId,
    });
    await app.client.close();
    daemon = await f.restart();
    await expect.poll(() => daemon.automationWebhooks?.enabled("relay"), wait).toBe(true);
    expect(await (await deliver(daemon, () => f.h.clock.now(), hookId, secret)).json()).toEqual({
      runId,
    });
    const again = await connectAutomations({ ...f, daemon }, "webhook-person");
    try {
      const history = await again.ask({
        type: "automation.inbox",
        requestId: "after",
        automationId: "deploy-check",
        limit: 50,
      });
      expect(history.inbox?.runs).toHaveLength(1);
      // The secret is in no list or history the person's apps read.
      const list = await again.ask({
        type: "automation.list",
        requestId: "l",
        includeThreads: true,
      });
      const key = secret.slice("whsec_".length);
      expect(JSON.stringify(list)).not.toContain(key);
      expect(JSON.stringify(history)).not.toContain(key);
      // Nor in a copy of the store's files: it is sealed with a key kept beside them, owner-only.
      const dataDir = readConfig({ ACE_HOME: join(f.h.home, "daemon") }).dataDir;
      for (const file of ["automations.sqlite", "automations.sqlite-wal"]) {
        const path = join(dataDir, file);
        if (existsSync(path)) expect(readFileSync(path).toString("latin1")).not.toContain(key);
      }
      expect(statSync(join(dataDir, webhookKeyName)).mode & 0o777).toBe(0o600);
    } finally {
      await again.client.close();
    }
  } finally {
    await daemon.close();
  }
});

test("a wrong secret, a rotated secret, a revoked webhook and a paused automation are refused without a run", async () => {
  const { f, app, webhook, runs } = await setUp();
  try {
    await f.daemon.settings.set("remote.relayWebhooks", true, { kind: "global" });
    await expect.poll(() => f.daemon.automationWebhooks?.enabled("relay"), wait).toBe(true);
    const first = await webhook("rotate", "rotate-1");
    const old = first.secret ?? "";
    const hookId = hookIdOf(first);
    const second = await webhook("rotate", "rotate-2");
    const current = second.secret ?? "";
    expect(hookIdOf(second)).toBe(hookId);
    expect((await deliver(f.daemon, () => f.h.clock.now(), hookId, old)).status).toBe(401);
    expect(
      (await deliver(f.daemon, () => f.h.clock.now(), hookId, current, { body: [1] })).status,
    ).toBe(422);

    expect(
      await app.ask({
        type: "automation.setEnabled",
        requestId: "pause",
        id: "deploy-check",
        enabled: false,
      }),
    ).toMatchObject({ ok: true });
    expect((await deliver(f.daemon, () => f.h.clock.now(), hookId, current)).status).toBe(409);

    expect(await webhook("revoke", "revoke")).toMatchObject({
      ok: true,
      webhook: { active: false, path: null, url: null },
    });
    expect((await deliver(f.daemon, () => f.h.clock.now(), hookId, current)).status).toBe(404);
    expect(await runs()).toHaveLength(0);
    // The method is checked first, so a GET says only that: the hook is gone either way.
    const get = await f.daemon.automationWebhooks?.relay(
      new Request(`${forwarded.origin}${forwarded.prefix}/hooks/${hookId}`),
      new AbortController().signal,
      forwarded,
    );
    expect(get?.status).toBe(405);
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

/** The hook id at the end of the webhook's path. */
function hookIdOf(response: AutomationWebhookResponse): string {
  return response.webhook?.path?.slice("/hooks/".length) ?? "";
}

test("an agent's webhook automation runs once the person makes its secret, from the agents' store", async () => {
  const f = await daemonFixture();
  const app = await connectAutomations(f, "webhook-person");
  try {
    await f.daemon.settings.set("automations.enabled", true, { kind: "global" });
    await f.daemon.settings.set("remote.relayWebhooks", true, { kind: "global" });
    await expect.poll(() => f.daemon.automationWebhooks?.enabled("relay"), wait).toBe(true);
    const saved = await f.call({
      op: "automation.manage",
      request: {
        type: "automation.put",
        requestId: "agent-put",
        automation: {
          id: "agent-hook",
          title: "Agent hook",
          prompt: "Look at {{body.env}}",
          trigger: { kind: "webhook" },
          enabled: true,
          missedRun: "skip",
          concurrency: 1,
        },
      },
    });
    expect(saved.ok).toBe(true);
    const ask = async (source: "person" | "thread", requestId: string) => {
      app.client.send({
        type: "automation.webhook",
        requestId,
        id: "agent-hook",
        action: "rotate",
        source,
      });
      for (;;) {
        const response = await app.client.next();
        if (response.type === "automation.webhookResult" && response.requestId === requestId)
          return response as AutomationWebhookResponse;
      }
    };
    // It isn't the person's own automation, so only the thread store answers for it.
    expect(await ask("person", "wrong-store")).toMatchObject({ ok: false });
    const made = await ask("thread", "rotate");
    expect(made).toMatchObject({ ok: true, webhook: { active: true } });
    const listed = await app.ask({ type: "automation.list", requestId: "l", includeThreads: true });
    expect(listed.threadAutomations?.[0]?.webhook).toMatchObject({
      active: true,
      path: made.webhook?.path,
    });

    const delivered = await deliver(
      f.daemon,
      () => f.h.clock.now(),
      hookIdOf(made),
      made.secret ?? "",
    );
    expect(delivered.status).toBe(202);
    const runs = await f.call({
      op: "automation.manage",
      request: { type: "automation.inbox", requestId: "runs", limit: 10 },
    });
    expect(JSON.stringify(runs.data)).toContain('"trigger":"webhook"');
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

test("an agent's automation with the same id doesn't hide the person's webhook", async () => {
  const { f, app, webhook, listed } = await setUp();
  try {
    expect((await webhook("rotate", "rotate")).ok).toBe(true);
    const clash = await f.call({
      op: "automation.manage",
      request: {
        type: "automation.put",
        requestId: "clash",
        automation: {
          id: "deploy-check",
          title: "Same id, agent's",
          prompt: "Anything",
          trigger: { kind: "manual" },
          enabled: true,
          missedRun: "skip",
          concurrency: 1,
        },
      },
    });
    expect(clash.ok).toBe(true);
    const list = await app.ask({
      type: "automation.list",
      requestId: "both",
      includeThreads: true,
    });
    expect(list.schedules?.[0]?.webhook).toMatchObject({ active: true });
    expect(list.threadAutomations?.[0]?.webhook).toBeUndefined();
    expect((await listed()).schedules?.[0]?.webhook).toMatchObject({ active: true });
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

test("a webhook past 60 new deliveries a minute is told to retry later, with no run", async () => {
  const { f, app, webhook, runs } = await setUp();
  try {
    await f.daemon.settings.set("remote.relayWebhooks", true, { kind: "global" });
    await expect.poll(() => f.daemon.automationWebhooks?.enabled("relay"), wait).toBe(true);
    const made = await webhook("rotate", "rotate");
    const send = (id: string) =>
      deliver(f.daemon, () => f.h.clock.now(), hookIdOf(made), made.secret ?? "", { id });
    for (let i = 1; i <= 60; i++) expect((await send(`evt_${i}`)).status).toBe(202);
    const over = await send("evt_61");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect((await runs()).some((run) => run.eventKey === "webhook:evt_61")).toBe(false);
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

/** A real HTTP POST to the outside endpoint's port, with the Host a proxy for `host` would keep. */
function postAt(
  port: number,
  host: string,
  path: string,
  secret: string,
  now: number,
): Promise<number> {
  const seconds = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({ env: "prod" }));
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          "content-length": payload.length,
          "webhook-id": "evt_own",
          "webhook-timestamp": String(seconds),
          "webhook-signature": signWebhook(secret, "evt_own", seconds, payload),
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once("error", reject);
    request.end(payload);
  });
}

test("at the person's own URL a webhook runs with its switch on, and never at the loopback address", async () => {
  const { f, app, webhook, runs } = await setUp();
  try {
    const made = await webhook("rotate", "rotate");
    const path = made.webhook?.path ?? "";
    const port = Number(new URL(f.daemon.externalMcp?.url ?? "").port);
    await f.daemon.settings.set("remote.mcpPublicUrl", "https://hooks.example.com", {
      kind: "global",
    });
    const now = () => f.h.clock.now();
    // Off: the request goes on to the outside MCP endpoint, which has no such page.
    expect(await postAt(port, "hooks.example.com", path, made.secret ?? "", now())).not.toBe(202);
    await f.daemon.settings.set("remote.publicUrlWebhooks", true, { kind: "global" });
    await expect.poll(() => f.daemon.automationWebhooks?.enabled("custom"), wait).toBe(true);
    // The loopback address itself never serves webhooks, switch or not.
    expect(await postAt(port, `127.0.0.1:${port}`, path, made.secret ?? "", now())).not.toBe(202);
    expect(await postAt(port, "hooks.example.com", path, made.secret ?? "", now())).toBe(202);
    expect(await runs()).toHaveLength(1);
    // Nor does it when the person's own URL is set to a loopback address.
    await f.daemon.settings.set("remote.mcpPublicUrl", `https://127.0.0.1:${port}`, {
      kind: "global",
    });
    await expect
      .poll(() => f.daemon.automationWebhooks?.state("deploy-check").problem, wait)
      .toMatch(/points at this computer/);
    expect(await postAt(port, `127.0.0.1:${port}`, path, made.secret ?? "", now())).not.toBe(202);
    await f.daemon.settings.set("remote.mcpPublicUrl", "https://hooks.example.com", {
      kind: "global",
    });
    await expect
      .poll(() => f.daemon.automationWebhooks?.state("deploy-check").url, wait)
      .toBe(`https://hooks.example.com${path}`);
    // The list leads with the address ace cloud doesn't carry.
    expect(f.daemon.automationWebhooks?.state("deploy-check")).toMatchObject({
      url: `https://hooks.example.com${path}`,
      urls: [{ via: "custom" }],
    });
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

test("a webhook run never lands in a thread with more access than the automation allows", async () => {
  const { f, app, automation, webhook, runs } = await setUp();
  const threads = () =>
    f.daemon.store.listThreads().filter((thread) => thread.title.includes("Deploy check"));
  const access = (id: string) =>
    f.daemon.store.getThread(ThreadId.parse(id))?.permission?.effective;
  try {
    // First it ran by hand, at the machine's full-access default, as a manual automation.
    const manual = { ...automation, trigger: { kind: "manual" as const }, prompt: "Check it" };
    expect(
      await app.ask({ type: "automation.put", requestId: "manual", automation: manual }),
    ).toMatchObject({ ok: true });
    await app.ask({
      type: "automation.run",
      requestId: "by-hand",
      id: automation.id,
      variables: {},
    });
    await expect.poll(() => threads().length, wait).toBe(1);
    const first = threads()[0]?.id ?? "";
    await expect.poll(() => access(first), wait).toBe("full-access");
    await answer(f, ThreadId.parse(first), 1, "manual-answer", "Checked.");
    await expect.poll(async () => (await runs())[0]?.status, wait).toBe("succeeded");

    // Then it became a webhook automation with no access of its own: read-only.
    expect(
      await app.ask({ type: "automation.put", requestId: "webhook", automation }),
    ).toMatchObject({ ok: true });
    await f.daemon.settings.set("remote.relayWebhooks", true, { kind: "global" });
    await expect.poll(() => f.daemon.automationWebhooks?.enabled("relay"), wait).toBe(true);
    const made = await webhook("rotate", "rotate");
    const sent = await deliver(f.daemon, () => f.h.clock.now(), hookIdOf(made), made.secret ?? "");
    expect(sent.status).toBe(202);
    await expect.poll(() => threads().length, wait).toBe(2);
    const second = threads().find((thread) => thread.id !== first)?.id ?? "";
    await expect.poll(() => access(second), wait).toBe("read-only");
    // The webhook's prompt went to the new read-only thread, and none of it to the old one.
    await expect
      .poll(() => JSON.stringify(f.h.inputs.get(ThreadId.parse(second)) ?? []), wait)
      .toContain("Check the prod deploy");
    expect(JSON.stringify(f.h.inputs.get(ThreadId.parse(first)) ?? [])).not.toContain("prod");
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

test("a webhook run doesn't reuse its thread once the person has asked to widen it", async () => {
  const { f, app, webhook } = await setUp();
  const threads = () =>
    f.daemon.store.listThreads().filter((thread) => thread.title.includes("Deploy check"));
  try {
    await f.daemon.settings.set("remote.relayWebhooks", true, { kind: "global" });
    await expect.poll(() => f.daemon.automationWebhooks?.enabled("relay"), wait).toBe(true);
    const made = await webhook("rotate", "rotate");
    const send = (id: string) =>
      deliver(f.daemon, () => f.h.clock.now(), hookIdOf(made), made.secret ?? "", { id });
    expect((await send("evt_1")).status).toBe(202);
    await expect.poll(() => threads().length, wait).toBe(1);
    const first = ThreadId.parse(threads()[0]?.id);
    await answer(f, first, 1, "first-answer", "Checked.");
    // While it stays read-only, the next delivery goes into the same thread.
    expect((await send("evt_1b")).status).toBe(202);
    await expect.poll(() => f.h.inputs.get(first)?.length ?? 0, wait).toBe(2);
    expect(threads()).toHaveLength(1);
    await answer(f, first, 2, "second-answer", "Checked again.");
    // Asked for while the thread is idle, so the new access may still be pending.
    expect(
      personCommand(f, "widen", {
        type: "thread.permission.set",
        threadId: first,
        access: "full-access",
      })?.ok,
    ).toBe(true);
    expect((await send("evt_2")).status).toBe(202);
    await expect.poll(() => threads().length, wait).toBe(2);
    const second = ThreadId.parse(threads().find((thread) => thread.id !== first)?.id);
    await expect
      .poll(() => f.daemon.store.getThread(second)?.permission?.effective, wait)
      .toBe("read-only");
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});
