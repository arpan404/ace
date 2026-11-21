import "./test-host.ts";
import { facts } from "@ace/fake-daemon";
import { Interaction } from "@ace/protocol";
import { wholeRequestNotRead } from "@ace/ui-core";
import { afterEach, describe, expect, it } from "vitest";
import { needsResolution } from "./inbox-needs.ts";
import { interactionRow } from "./interaction-rows.ts";
import { alertActions, alertAnswer, alertRequest } from "./notification-request.ts";
import { approvalResolution, type WholeRequestState } from "./summarized-requests.ts";
import { answerResolution } from "./thread-controls.ts";
import {
  commands,
  connect,
  fixture,
  latest,
  open,
  reset,
  rows,
  sent,
  until,
} from "./thread-harness.ts";
import { requestResolution } from "./thread-requests.ts";

/*
 * A request the daemon sends summarized (ADR 0157) offers only declines until the phone reads its
 * whole payload on demand (`request.read` -> `interaction.read`). Once that exact version has
 * loaded, affirmative answers carry its `version` in `readWhole`; if the summary changes
 * meanwhile or the thread copy is stale, the old version is never answered.
 */

afterEach(reset);

const reader = { item: () => undefined, agent: () => undefined, thread: { provider: "claude" } };

const pending = (request: unknown, summarized: boolean) =>
  Interaction.parse({
    id: "ask",
    threadId: "thread",
    agentId: "root",
    blocking: true,
    request,
    state: "pending",
    createdAt: 1,
    ...(summarized ? { truncated: { chars: 400_000 } } : {}),
  });

const approval = {
  kind: "approval" as const,
  title: "Run the build",
  description: "Builds every package…",
  target: { tool: "Bash", command: "make", access: "execute" as const },
  options: [
    { id: "allow", label: "Allow once", kind: "allow_once" as const },
    { id: "always", label: "Always allow", kind: "allow_always" as const },
    { id: "deny", label: "Deny", kind: "deny" as const },
  ],
};
const plan = {
  kind: "plan_review" as const,
  title: "Ship kill-all",
  markdown: "1. Record start times…",
};
const question = {
  kind: "question" as const,
  questions: [
    {
      id: "scope",
      text: "Include the archived posts?",
      multiSelect: false,
      allowOther: true,
      secret: false,
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    },
  ],
};
const form = {
  kind: "elicitation" as const,
  server: "github",
  message: "Pick a repository…",
  mode: "form" as const,
  schema: {
    type: "object",
    properties: {
      repo: { type: "string", title: "Repository" },
    },
    required: ["repo"],
  },
};

describe("an approval sent summarized", () => {
  const asked = pending(approval, true);
  const row = interactionRow(asked, reader, "make");

  it("offers Deny alone until the whole request loads", () => {
    expect(row.options.map((option) => option.id)).toEqual(["deny"]);
    expect(row.decisions.map((decision) => decision.verb)).toEqual(["deny"]);
    expect(row.others).toEqual([]);
    expect(row.wholeState).toBe("unread");
    expect(row.summarized).toBe(
      "This request is too large to show with the thread. Review it to read it in full before you approve it.",
    );
    expect(row.strip.detail).toBe(row.summarized);
    expect(approvalResolution(asked, "allow", false)).toBeUndefined();
    expect(approvalResolution(asked, "deny", false)).toEqual({
      kind: "approval",
      optionId: "deny",
    });
  });

  it("reveals all options and clears the note once loaded whole", () => {
    const loaded: WholeRequestState = {
      status: "loaded",
      request: Interaction.parse({ ...asked, truncated: undefined }).request,
      version: "v-loaded",
    };
    const fullRow = interactionRow(asked, reader, "make", loaded);
    expect(fullRow.options.map((option) => option.id)).toEqual(["allow", "always", "deny"]);
    expect(fullRow.decisions.map((decision) => decision.verb)).toEqual([
      "allow_once",
      "always_allow",
      "deny",
    ]);
    expect(fullRow.wholeState).toBe("loaded");
    expect(fullRow.summarized).toBe("");
  });

  it("is denied from the inbox but never allowed without loading the thread request", () => {
    expect(needsResolution(asked, { kind: "approval", optionId: "deny" })).toEqual({
      kind: "approval",
      optionId: "deny",
    });
    expect(needsResolution(asked, { kind: "approval", optionId: "allow" })).toBeUndefined();
    expect(needsResolution(asked, { kind: "approval", optionId: "always" })).toBeUndefined();
  });
});

it("an approval sent whole offers every option and no note", () => {
  const row = interactionRow(pending(approval, false), reader, "make");
  expect(row.options.map((option) => option.id)).toEqual(["allow", "always", "deny"]);
  expect(row.summarized).toBe("");
  expect(row.wholeState).toBeUndefined();
  expect(
    needsResolution(pending(approval, false), { kind: "approval", optionId: "allow" }),
  ).toEqual({ kind: "approval", optionId: "allow" });
});

it("a plan sent summarized can be sent back or cancelled before loading, and approved once loaded", () => {
  const asked = pending(plan, true);
  expect(interactionRow(asked, reader).summarized).toBe(
    "This request is too large to show with the thread. Review it to read it in full before you approve it.",
  );
  expect(requestResolution(asked, { kind: "plan", decision: "approve" })).toBeUndefined();
  expect(requestResolution(asked, { kind: "plan", decision: "cancel" })).toEqual({
    kind: "plan_review",
    decision: "cancel",
  });
  expect(
    requestResolution(asked, { kind: "plan", decision: "reject", feedback: "Smaller steps" }),
  ).toEqual({ kind: "plan_review", decision: "reject", feedback: "Smaller steps" });
  const loaded: WholeRequestState = {
    status: "loaded",
    request: asked.request,
    version: "v-plan",
  };
  const fullRow = interactionRow(asked, reader, "", loaded);
  expect(fullRow.summarized).toBe("");
  expect(fullRow.plan?.truncated).toBe(false);
  expect(
    requestResolution(
      Interaction.parse({ ...asked, truncated: undefined }),
      { kind: "plan", decision: "approve" },
      true,
    ),
  ).toEqual({
    kind: "plan_review",
    decision: "approve",
  });
});

it("a question sent summarized can only be skipped until loaded whole", () => {
  const asked = pending(question, true);
  const row = interactionRow(asked, reader);
  expect(row.unanswerable).toBe(true);
  expect(row.summarized).toBe(
    "This request is too large to show with the thread. Review it to read it in full before you answer it.",
  );
  expect(answerResolution(asked, { scope: ["yes"] }, false)).toBeUndefined();
  expect(answerResolution(asked, {}, true)).toEqual({
    kind: "question",
    answers: {},
    dismissed: true,
  });
  const loaded: WholeRequestState = {
    status: "loaded",
    request: asked.request,
    version: "v-question",
  };
  const fullRow = interactionRow(asked, reader, "", loaded);
  expect(fullRow.unanswerable).toBe(false);
  expect(fullRow.summarized).toBe("");
  expect(
    answerResolution(
      Interaction.parse({ ...asked, truncated: undefined }),
      { scope: ["yes"] },
      false,
      true,
    ),
  ).toEqual({
    kind: "question",
    answers: { scope: ["yes"] },
  });
});

it("a form sent summarized can be declined before loading, and filled in once loaded", () => {
  const asked = pending(form, true);
  const row = interactionRow(asked, reader);
  expect(row.form).toMatchObject({ unsupported: true, fields: [] });
  expect(row.summarized).toBe(
    "This request is too large to show with the thread. Review it to read it in full before you answer it.",
  );
  expect(
    requestResolution(asked, { kind: "form", action: "accept", values: { repo: "ace" } }),
  ).toBeUndefined();
  expect(requestResolution(asked, { kind: "form", action: "decline" })).toEqual({
    kind: "elicitation",
    action: "decline",
  });
  const loaded: WholeRequestState = {
    status: "loaded",
    request: asked.request,
    version: "v-form",
  };
  const fullRow = interactionRow(asked, reader, "", loaded);
  expect(fullRow.form?.unsupported).toBe(false);
  expect(fullRow.form?.fields.map((field) => field.key)).toEqual(["repo"]);
});

describe("a notification for a summarized request", () => {
  const actions = [
    { action: "approve" as const, optionId: "allow" },
    { action: "deny" as const, optionId: "deny" },
  ];

  it("keeps Deny and drops Approve", () => {
    expect(alertActions(actions, pending(approval, true))).toEqual([
      { action: "deny", optionId: "deny" },
    ]);
    expect(alertActions(actions, pending(approval, false))).toEqual(actions);
  });

  it("offers no answers to a question, and a tapped one answers nothing", () => {
    const asked = pending(question, true);
    expect(alertRequest(asked, reader)).toMatchObject({ choices: [], reply: false });
    expect(alertAnswer(asked, "scope", "yes")).toBeUndefined();
    expect(alertRequest(pending(question, false), reader)).toMatchObject({
      choices: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      reply: true,
    });
  });
});

/** The card of `kind` on the phone, once it shows `whole` when given. */
const card = (kind: string, whole?: string) =>
  until(
    () =>
      rows("thread.interaction").find(
        (row) => row.kind === kind && (whole === undefined || row.wholeState === whole),
      ),
    `the ${kind} card${whole ? ` ${whole}` : ""}`,
  );
const admitted = async (id: string) => (await until(() => latest("admission", id), id)).ok;

const manifest = `Shard manifest:\n${"partition checksum ok\n".repeat(4000)}`;
const approvalAsk = (description: string) => ({
  type: "interaction.opened" as const,
  agent: "root",
  interaction: "migrate",
  blocking: true,
  request: {
    kind: "approval" as const,
    title: "Run the migration",
    description,
    target: { tool: "Bash", command: "bun scripts/migrate.ts", access: "execute" as const },
    options: [
      { id: "allow", label: "Allow once", kind: "allow_once" as const },
      { id: "deny", label: "Deny", kind: "deny" as const },
    ],
  },
});
/** A thread `threadId` asking `asks`, opened on the phone. */
function asking(threadId: string, asks: unknown[], options: Parameters<typeof connect>[1] = {}) {
  const daemon = fixture();
  daemon.createThread({ id: threadId, workspaceId: "ace", title: "Large", provider: "claude" });
  daemon.apply(threadId, [facts.rootAgent("claude"), facts.turn("root"), ...(asks as never[])]);
  const client = connect(daemon, options);
  return { daemon, client, session: open(client, threadId) };
}

describe("a summarized request read whole on the phone", () => {
  it("allows only once read whole, naming the version it read", async () => {
    const { daemon, session } = asking("t-allow", [approvalAsk(manifest)]);
    const summary = await card("approval", "unread");
    const id = String(summary.id);
    expect((summary.options as { id: string }[]).map((option) => option.id)).toEqual(["deny"]);

    session.handle({ type: "approve", interactionId: id, optionId: "allow", requestId: "early" });
    expect(await admitted("early")).toBe(false);
    expect(commands("interaction.resolve")).toHaveLength(0);

    session.handle({ type: "request.read", interactionId: id });
    const whole = await card("approval", "loaded");
    const version = String(whole.wholeVersion);
    expect(whole.summarized).toBe("");
    expect(whole.description).toBe(manifest);
    expect((whole.options as { id: string }[]).map((option) => option.id)).toEqual([
      "allow",
      "deny",
    ]);

    session.handle({
      type: "approve",
      interactionId: id,
      optionId: "allow",
      version,
      requestId: "read",
    });
    expect((await until(() => latest("receipt", "read"), "the receipt")).ok).toBe(true);
    expect(commands("interaction.resolve")).toEqual([
      expect.objectContaining({
        interactionId: id,
        resolution: { kind: "approval", optionId: "allow" },
        readWhole: version,
      }),
    ]);
    expect(daemon.interactionOf("t-allow", id)?.state).toBe("resolved");
  });

  it("approves a plan and answers a question once each is read whole", async () => {
    const markdown = `## Plan\n\n${"1. Verify the partition, then swap its pointer.\n".repeat(1800)}`;
    const { daemon, session } = asking("t-plan", [
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "plan",
        blocking: true,
        request: { kind: "plan_review", title: "Migrate the shards", markdown },
      },
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "which",
        blocking: true,
        request: {
          kind: "question",
          questions: [
            {
              id: "target",
              text: `Which partitions?\n${"partition detail ".repeat(4500)}`,
              multiSelect: false,
              allowOther: false,
              secret: false,
              options: [
                { id: "all", label: "All shards" },
                { id: "canary", label: "Canary only" },
              ],
            },
          ],
        },
      },
    ]);
    const planId = String((await card("plan_review", "unread")).id);
    const questionId = String((await card("question", "unread")).id);
    const approve = { kind: "plan", decision: "approve" } as const;
    session.handle({ type: "resolve", interactionId: planId, answer: approve, requestId: "p0" });
    session.handle({
      type: "answer",
      interactionId: questionId,
      answers: { target: ["all"] },
      dismissed: false,
      requestId: "q0",
    });
    expect(await admitted("p0")).toBe(false);
    expect(await admitted("q0")).toBe(false);

    session.handle({ type: "request.read", interactionId: planId });
    session.handle({ type: "request.read", interactionId: questionId });
    const whole = await card("plan_review", "loaded");
    expect(whole.plan).toMatchObject({ markdown, truncated: false });
    const asked = await card("question", "loaded");
    expect(asked.unanswerable).toBe(false);

    session.handle({
      type: "resolve",
      interactionId: planId,
      answer: approve,
      version: String(whole.wholeVersion),
      requestId: "p1",
    });
    session.handle({
      type: "answer",
      interactionId: questionId,
      answers: { target: ["all"] },
      dismissed: false,
      version: String(asked.wholeVersion),
      requestId: "q1",
    });
    expect((await until(() => latest("receipt", "p1"), "the plan's receipt")).ok).toBe(true);
    expect((await until(() => latest("receipt", "q1"), "the answer's receipt")).ok).toBe(true);
    expect(daemon.interactionOf("t-plan", planId)?.resolution).toEqual({
      kind: "plan_review",
      decision: "approve",
    });
    expect(daemon.interactionOf("t-plan", questionId)?.resolution).toEqual({
      kind: "question",
      answers: { target: ["all"] },
    });
  });

  it("never answers the version it read once the request has changed: it shows the new one", async () => {
    const { daemon, session } = asking("t-changed", [approvalAsk(manifest)]);
    const id = String((await card("approval", "unread")).id);
    session.handle({ type: "request.read", interactionId: id });
    const read = String((await card("approval", "loaded")).wholeVersion);

    // The request changes on the machine after the phone read it.
    const changed = `${manifest}\nPartition 901 added`;
    const stored = daemon.interactionOf("t-changed", id);
    if (stored?.request.kind !== "approval") throw new Error("No stored approval");
    stored.request.description = changed;

    session.handle({
      type: "approve",
      interactionId: id,
      optionId: "allow",
      version: read,
      requestId: "old",
    });
    const refused = await until(() => latest("receipt", "old"), "the refusal");
    expect(refused.ok).toBe(false);
    expect(refused.message).toBe(wholeRequestNotRead);
    expect(daemon.interactionOf("t-changed", id)?.state).toBe("pending");

    // The refusal reads it again, so the card shows what the machine now asks.
    const shown = await until(
      () => rows("thread.interaction").find((row) => row.description === changed),
      "the new version on the card",
    );
    session.handle({
      type: "approve",
      interactionId: id,
      optionId: "allow",
      version: String(shown.wholeVersion),
      requestId: "new",
    });
    expect((await until(() => latest("receipt", "new"), "the receipt")).ok).toBe(true);
    expect(daemon.interactionOf("t-changed", id)?.state).toBe("resolved");
  });

  it("refuses a tap made on an older version once a newer one has loaded", async () => {
    const { daemon, session } = asking("t-stale", [approvalAsk(manifest)]);
    const id = String((await card("approval", "unread")).id);
    session.handle({ type: "request.read", interactionId: id });
    const seen = String((await card("approval", "loaded")).wholeVersion);
    expect(seen).toMatch(/^[0-9a-f]{64}$/);

    const changed = `${manifest}\nPartition 902 added`;
    const stored = daemon.interactionOf("t-stale", id);
    if (stored?.request.kind !== "approval") throw new Error("No stored approval");
    stored.request.description = changed;
    // A refused answer makes the phone read the new version, as any change would.
    session.handle({
      type: "approve",
      interactionId: id,
      optionId: "allow",
      version: seen,
      requestId: "first",
    });
    await until(() => latest("receipt", "first"), "the first refusal");
    const fresh = await until(
      () => rows("thread.interaction").find((row) => row.description === changed),
      "the new version on the card",
    );
    expect(fresh.wholeVersion).not.toBe(seen);

    // A tap the person made on the old card, arriving after the new one loaded.
    for (const [requestId, action] of [
      ["approve", { type: "approve", optionId: "allow" }],
      ["deny", { type: "approve", optionId: "deny" }],
    ] as const) {
      session.handle({ ...action, interactionId: id, version: seen, requestId });
      expect(await admitted(requestId)).toBe(false);
    }
    session.handle({ type: "approve", interactionId: id, optionId: "allow", requestId: "bare" });
    expect(await admitted("bare")).toBe(false);
    expect(daemon.interactionOf("t-stale", id)?.state).toBe("pending");

    session.handle({
      type: "approve",
      interactionId: id,
      optionId: "allow",
      version: String(fresh.wholeVersion),
      requestId: "seen",
    });
    expect((await until(() => latest("receipt", "seen"), "the receipt")).ok).toBe(true);
    expect(daemon.interactionOf("t-stale", id)?.state).toBe("resolved");
  });

  it("answers nothing from a copy the machine hasn't confirmed", async () => {
    const kept = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => kept.get(key),
      set: async (key: string, value: unknown) => void kept.set(key, value),
    };
    asking("t-held", [approvalAsk(manifest)], { readSnapshots: storage });
    await card("approval");
    await until(() => kept.size > 0, "the kept copy");
    await reset();

    // Launched again, the kept copy paints while the machine hasn't answered yet.
    const daemon = fixture();
    daemon.createThread({ id: "t-held", workspaceId: "ace", title: "Large", provider: "claude" });
    daemon.apply("t-held", [facts.rootAgent("claude"), facts.turn("root"), approvalAsk(manifest)]);
    const session = open(
      connect(daemon, { held: new Promise<void>(() => {}), readSnapshots: storage }),
      "t-held",
    );
    const id = String((await card("approval")).id);
    session.handle({ type: "approve", interactionId: id, optionId: "deny", requestId: "held" });
    const admission = await until(() => latest("admission", "held"), "the refusal");
    expect(admission.ok).toBe(false);
    expect(admission.message).toContain("finish syncing");
    expect(sent.filter((frame) => frame.includes("interaction.resolve"))).toHaveLength(0);
  });
});
