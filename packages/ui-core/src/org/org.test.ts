import { describe, expect, test } from "vitest";
import { policyDraft, policyFromDraft, readAuditLines, readPolicy } from "./index.ts";

const hash = `sha256:${"a".repeat(64)}`;

describe("an organization's policy as lines of text", () => {
  test("a saved list reads back as the same lines, blanks and repeats dropped", () => {
    const draft = policyDraft({});
    const saved = policyFromDraft({
      ...draft,
      allow: "registry *\n\n  market spade-bot/ci  \nregistry *\nplain-name",
      block: `${hash}\nbad-skill`,
      endpoints: "api.example.com\napi.example.com\n",
    });

    expect(saved.packages?.allow).toEqual([
      { source: "registry", name: "*" },
      { source: "market", name: "spade-bot/ci" },
      { source: "market", name: "plain-name" },
    ]);
    expect(saved.packages?.block).toEqual([{ hash }, { name: "bad-skill" }]);
    const again = policyDraft(readPolicy(JSON.stringify(saved)));
    expect(again.allow).toBe("registry *\nmarket spade-bot/ci\nmarket plain-name");
    expect(again.block).toBe(`${hash}\nbad-skill`);
    expect(again.endpoints).toBe("api.example.com");
  });

  test("emptied lists leave the policy, and a member's subscription is never allowed", () => {
    const stored = readPolicy(
      JSON.stringify({
        packages: { mode: "allowlist", allow: [{ source: "git", name: "x" }] },
        models: { endpoints: ["a.example.com"], local: false },
      }),
    );
    const saved = policyFromDraft({ ...policyDraft(stored), allow: "", endpoints: " " });

    expect(saved.packages).toEqual({ mode: "allowlist", allow: undefined, block: undefined });
    expect(saved.models).toEqual({ local: false, endpoints: undefined, subscriptions: false });
  });

  test("a stored text this build can't read is no policy of its own", () => {
    expect(readPolicy("not json")).toEqual({});
    expect(readPolicy(JSON.stringify({ effects: { pay: "sometimes" } }))).toEqual({});
  });
});

describe("a host's audit export", () => {
  const text = [
    { kind: "header", org: "org_acme", host: "host_1", key: "key-1" },
    {
      kind: "entry",
      seq: 1,
      hash: "h1",
      action: "bot.effect",
      occurred_at: 1000,
      actor: { type: "bot", id: "bot_1", name: "Triage" },
      targets: [{ type: "repo", id: "acme/web" }],
      metadata: { allowed_by_account: "acct_dana" },
    },
    { kind: "checkpoint", count: 1, at: 1001 },
    { kind: "something-new", detail: 1 },
    {
      kind: "entry",
      seq: 2,
      hash: "h2",
      action: "custom.thing",
      occurred_at: 2000,
      actor: { type: "account", id: "acct_dana" },
      targets: [],
    },
  ]
    .map((line) => JSON.stringify(line))
    .concat(["{broken"])
    .join("\n");

  test("entries read in words, lines this build doesn't know are left out", () => {
    const read = readAuditLines(text);

    expect(read.header?.key).toBe("key-1");
    expect(read.checkpoints).toBe(1);
    expect(read.rows).toEqual([
      {
        seq: 1,
        action: "bot.effect",
        title: "Outward step",
        at: 1000,
        actor: "Triage",
        targets: "acme/web",
        allowedBy: "acct_dana",
      },
      {
        seq: 2,
        action: "custom.thing",
        title: "custom.thing",
        at: 2000,
        actor: "acct_dana",
        targets: "",
        allowedBy: undefined,
      },
    ]);
  });
});
