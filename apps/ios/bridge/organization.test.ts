import { expect, test } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { setUp } from "./spade-test-host.ts";
import {
  NativeOrganization,
  NativeOrganizationRequest,
  type OrganizationAudit,
  type PolicyForm,
} from "./organization.ts";

/*
 * Settings › Organization on the iPhone (ADR 0206 amendment 4), over the real SDK and a fake
 * Spade: the policy as the phone edits it, saved as the body of the next version, and an org
 * host's audit log, newest first, filtered by person and kind, exported whole.
 */

type AuditRead = Extract<OrganizationAudit, { ok: true }>;

function bindToAcme(fake: FakeSpadeApi) {
  fake.org.binding = { org: "org_acme", name: "Acme", host: "host_1", policy: 1, auditKey: "k1" };
}

const entry = (seq: number, action: string, actor: string, at = seq * 1000) => ({
  kind: "entry",
  seq,
  hash: `h${seq}`,
  action,
  occurredAt: at,
  actor: { type: "account", id: actor.toLowerCase(), name: actor },
  targets: [{ type: "bot", id: "bot_1", name: "Triage" }],
});

async function host(seed: (fake: FakeSpadeApi) => void = () => {}) {
  let clock = 0;
  const { owner } = await setUp(seed);
  const organization = new NativeOrganization(owner, {
    id: () => crypto.randomUUID(),
    now: () => clock,
  });
  const ask = (request: unknown) =>
    organization.answer(NativeOrganizationRequest.parse({ type: "native.organization", request }));
  return { ask, later: (ms: number) => (clock += ms) };
}

const stored = JSON.stringify({
  effects: { pay: "off" },
  packages: { mode: "allowlist", allow: [{ source: "registry", name: "*" }] },
  models: { endpoints: ["api.example.com"], local: false },
  audit: { content: "targets" },
});

test("the stored policy opens as the phone's form, its lists as lines", async () => {
  const { ask } = await host();

  const answer = (await ask({ op: "policyForm", body: stored })) as { form: PolicyForm };

  expect(answer.form).toMatchObject({
    effects: { pay: "off", publish: "unset" },
    fullAccess: "unset",
    membersCreateBots: true,
    sources: { market: true, registry: true, git: false },
    allowlist: true,
    allow: "registry *",
    block: "",
    endpoints: "api.example.com",
    localModels: false,
    auditContent: "targets",
  });
});

test("a saved form is the next version's body, keeping what the form didn't touch", async () => {
  const { ask } = await host();
  const { form } = (await ask({ op: "policyForm", body: stored })) as { form: PolicyForm };

  const saved = (await ask({
    op: "policySave",
    body: stored,
    version: 3,
    form: {
      ...form,
      effects: { ...form.effects, pay: "unset", publish: "admins" },
      fullAccess: "never",
      allow: "registry *\nmarket spade-bot/ci",
      block: "",
      endpoints: "",
    },
  })) as { body: string };

  expect(JSON.parse(saved.body)).toEqual({
    policy: {
      effects: { publish: "admins" },
      full_access: "never",
      members_create_bots: true,
      packages: {
        mode: "allowlist",
        sources: { market: true, registry: true, git: false },
        allow: [
          { source: "registry", name: "*" },
          { source: "market", name: "spade-bot/ci" },
        ],
      },
      models: { local: false, subscriptions: false },
      audit: { content: "targets" },
    },
    version: 3,
  });
});

test("the host's log lists newest first, and narrows to one person and one kind", async () => {
  const { ask } = await host((fake) => {
    bindToAcme(fake);
    fake.org.audit.push(
      entry(1, "bot.effect", "Dana"),
      { kind: "checkpoint", count: 1, at: 1500 },
      entry(2, "package.installed", "Sam"),
      entry(3, "bot.effect", "Sam"),
    );
  });

  const all = (await ask({ op: "audit" })) as AuditRead;
  expect(all.rows.map((row) => row.seq)).toEqual([3, 2, 1]);
  expect(all.people).toEqual(["Dana", "Sam"]);
  expect(all.kinds).toEqual([
    { action: "bot.effect", title: "Outward step" },
    { action: "package.installed", title: "Package installed" },
  ]);
  expect(all).toMatchObject({ ok: true, key: "k1", checkpoints: 1, total: 3 });

  const sams = (await ask({ op: "audit", person: "Sam", kind: "bot.effect" })) as AuditRead;
  expect(sams.rows.map((row) => row.seq)).toEqual([3]);
  expect(sams.total).toBe(3);
});

test("the list shows the newest fifty, and Export carries every line of the log", async () => {
  const { ask } = await host((fake) => {
    bindToAcme(fake);
    for (let seq = 1; seq <= 60; seq += 1) fake.org.audit.push(entry(seq, "bot.effect", "Dana"));
  });

  const listed = (await ask({ op: "audit" })) as AuditRead;
  expect(listed.rows).toHaveLength(50);
  expect(listed.rows[0]?.seq).toBe(60);

  const exported = (await ask({ op: "auditExport" })) as { ok: true; text: string };
  const lines = exported.text.trim().split("\n");
  expect(lines).toHaveLength(61);
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({ kind: "header", key: "k1" });
});

test("a filter change reads the log once, and a pull reads what came since", async () => {
  let fake: FakeSpadeApi | undefined;
  const { ask } = await host((seeded) => {
    fake = seeded;
    bindToAcme(seeded);
    seeded.org.audit.push(entry(1, "bot.effect", "Dana"));
  });
  await ask({ op: "audit" });
  fake?.org.audit.push(entry(2, "bot.effect", "Dana"));

  const filtered = (await ask({ op: "audit", person: "Dana" })) as AuditRead;
  expect(filtered.total).toBe(1);

  const pulled = (await ask({ op: "audit", fresh: true })) as AuditRead;
  expect(pulled.total).toBe(2);
});

test("a machine that isn't one of the organization's hosts says so", async () => {
  const { ask } = await host();

  const answer = await ask({ op: "audit" });

  expect(answer).toEqual({
    ok: false,
    message: "This machine isn't one of your organization's hosts, so it keeps no audit log.",
  });
});
