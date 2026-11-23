import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { policyDraft, policyFromDraft, readAuditLines, readPolicy } from "./index.ts";

const sample = readFileSync(
  new URL("../../../../spade/spec/org-audit-export.jsonl", import.meta.url),
  "utf8",
);
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

  test("an allowed package still listed keeps the versions it was allowed at", () => {
    const stored = readPolicy(
      JSON.stringify({
        packages: {
          allow: [
            { source: "market", name: "spade-bot/ci", versions: ["1.2.0"] },
            { source: "registry", name: "deploy", versions: ["2.0.0", "2.0.1"] },
          ],
        },
      }),
    );
    const draft = policyDraft(stored);
    // An unrelated edit: one more endpoint, and a new allowed package.
    const saved = policyFromDraft({
      ...draft,
      allow: `${draft.allow}\ngit tools/lint`,
      endpoints: "api.example.com",
    });

    expect(saved.packages?.allow).toEqual([
      { source: "market", name: "spade-bot/ci", versions: ["1.2.0"] },
      { source: "registry", name: "deploy", versions: ["2.0.0", "2.0.1"] },
      { source: "git", name: "tools/lint" },
    ]);
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
  // Spade's own export, as its serializer writes it (pinned by a test in `spade-core`), then
  // lines it never writes.
  const text = `${sample}{"kind":"something-new","detail":1}\n{broken`;

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
