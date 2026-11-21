import type { FakeSpadeApi } from "@ace/fake-daemon";
import { fakePerson } from "./fake-account.ts";
import { fakeOrgHostId, fakeOrgs } from "./fake-orgs.ts";

/*
 * `?fakeWorld=org`, Spade's side (ADR 0206 §2.3, §4.2): the build server's Spade belongs to Acme
 * Robotics. CI watcher is a shared bot whose approvers are the person and Dana, with a request
 * waiting for one of them; Research is shared too, approved by Dana alone; the host's log holds a
 * few entries, each naming who allowed it.
 */
export function seedFakeOrgSpade(remote: FakeSpadeApi, now: number) {
  const minutes = (count: number) => now - count * 60_000;
  remote.org.binding = {
    org: fakeOrgs.acme,
    name: "Acme Robotics",
    host: fakeOrgHostId,
    policy: 3,
    auditKey: "4YnbPAZLpD557zJQT9bDShIgb4lSIpvda8dHoDmZPM8",
  };
  const watcher = remote.addAgent({
    id: "ci-watcher",
    name: "CI watcher",
    avatar: {
      kind: "character",
      v: 1,
      body: "bot",
      pair: "stone",
      ears: "none",
      marking: "none",
      eyes: "round",
      mouth: "smile",
      cheeks: "none",
      accessory: "none",
    },
    access: "auto_review",
    last_activity: minutes(4),
    last_message: {
      from: "agent",
      text: "main is red: the api's contract tests fail after #412.",
      at: minutes(4),
      from_agent: null,
    },
  });
  remote.org.access.set("ci-watcher", {
    org: fakeOrgs.acme,
    maker: "user_dana",
    approvers: [fakePerson.id, "user_dana"],
  });
  remote.org.access.set("research", {
    org: fakeOrgs.acme,
    maker: "user_dana",
    approvers: ["user_dana"],
  });
  // A comment on the pull request, waiting for one of its approvers.
  remote.ask(watcher, "call-pr-comment", "github__create_issue_comment", {
    repo: "acme/api",
    issue: 412,
    body: "Contract tests fail on main after this merge: `orders.v2` drops `currency`.",
  });
  const entry = (seq: number, action: string, at: number, extra: Record<string, unknown>) => ({
    kind: "entry",
    seq,
    prev: seq === 1 ? "0".repeat(64) : `${seq - 1}`.padStart(64, "0"),
    hash: `${seq}`.padStart(64, "0"),
    action,
    occurred_at: at,
    ...extra,
  });
  remote.org.audit = [
    entry(1, "org.host.enrolled", minutes(60 * 24 * 6), {
      actor: { type: "member", id: "user_dana", name: "Dana Kim" },
      targets: [{ type: "host", id: fakeOrgHostId, name: "Build server" }],
    }),
    entry(2, "bot.created", minutes(60 * 24 * 6 - 20), {
      actor: { type: "member", id: "user_dana", name: "Dana Kim" },
      targets: [{ type: "bot", id: "ci-watcher", name: "CI watcher" }],
    }),
    entry(3, "package.installed", minutes(60 * 24 * 5), {
      actor: { type: "member", id: "user_dana", name: "Dana Kim" },
      targets: [{ type: "bot", id: "ci-watcher", name: "CI watcher" }],
      metadata: { source: "market", name: "spade-bot/ci-watcher", version: "1.4.0" },
    }),
    {
      kind: "checkpoint",
      count: 3,
      head: "3".padStart(64, "0"),
      at: minutes(60 * 24 * 5),
      signature: "sig",
    },
    entry(4, "bot.effect", minutes(60 * 3), {
      actor: { type: "bot", id: "ci-watcher", name: "CI watcher" },
      targets: [{ type: "repo", id: "acme/api" }],
      metadata: { effect: "pr_comment", allowed_by_account: "Arpan Bhandari" },
    }),
    entry(5, "bot.approval.answered", minutes(50), {
      actor: { type: "member", id: "user_dana", name: "Dana Kim" },
      targets: [{ type: "bot", id: "research", name: "Research" }],
    }),
  ];
}
