import { expect, it } from "vitest";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import type { Storage } from "@ace/client";
import type { ExpoPinnedBridge } from "../security/expo-bridge.ts";
import { createMemoryCredentialStore } from "../pairing/credentials.ts";
import { preparePairing } from "../pairing/pairing-flow.ts";
import {
  canResolveInteraction,
  isResolutionLocked,
  markResolutionSending,
} from "../interactions.ts";
import {
  buildApprovalResolvePayload,
  buildElicitationResolvePayload,
  buildPlanReviewResolvePayload,
  buildQuestionResolvePayload,
  canTapFreshProductionCard,
  canTapProductionCard,
  consentLink,
  consentLinkFailureCopy,
  currentProductionGrant,
  elicitationInvalidCopy,
  elicitationMode,
  elicitationResolution,
  elicitationUnsupported,
  freshProductionInteractionState,
  isCardableProductionInteraction,
  openConsentPage,
  pendingProductionInteractionIds,
  planReviewResolution,
  productionAnswerFailureCopy,
  productionApprovalRefusalCopy,
  productionElicitationRefusalCopy,
  productionMayAct,
  productionPlanRefusalCopy,
  productionQuestionRefusalCopy,
  resolveProductionApproval,
  resolveProductionElicitation,
  resolveProductionPlanReview,
  resolveProductionQuestion,
  shouldSuppressProductionReadOnly,
  submittedElicitationValues,
  type ElicitationRequest,
} from "./production-approvals.ts";
import {
  createProductionStartup,
  ViewOnlyError,
  type StartupDatabase,
} from "../runtime/production-startup.ts";

const PIN = "9f".repeat(32);
const TICKET = "f1".repeat(32);
const LINK = `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN}&scopes=read,operate`;
const THREAD = "thread-1";

function credential() {
  return {
    device: {
      id: "device-1",
      name: "My phone",
      scopes: ["read", "operate"],
      createdAt: 1,
      lastSeenAt: 1,
      revokedAt: null,
    },
    token: "e0".repeat(32),
  };
}

function memoryStorage(): Storage {
  const meta = new Map<string, string>();
  const records = new Map<string, string>();
  return {
    load: async () => meta.get("legacy") ?? null,
    save: async (value) => {
      meta.set("legacy", value);
    },
    hostBinding: {
      load: async () => meta.get("host") ?? null,
      save: async (value) => {
        meta.set("host", value);
      },
    },
    records: {
      load: async () => [...records.values()],
      write: async (id, value) => {
        if (value === null) records.delete(id);
        else records.set(id, value);
      },
    },
  };
}

function memoryDatabase(): StartupDatabase {
  const namespaces = new Map<string, { meta: Map<string, string>; records: Map<string, string> }>();
  let grants: Record<string, string[]> | null = null;
  return {
    ensureOutboxTables: async () => {},
    deleteNamespace: async (namespace) => {
      namespaces.delete(namespace);
    },
    storageFor: (namespace) => {
      let scope = namespaces.get(namespace);
      if (scope === undefined) {
        scope = { meta: new Map(), records: new Map() };
        namespaces.set(namespace, scope);
      }
      return {
        load: async () => scope.meta.get("legacy") ?? null,
        save: async (value) => {
          scope.meta.set("legacy", value);
        },
        hostBinding: {
          load: async () => scope.meta.get("host") ?? null,
          save: async (value) => {
            scope.meta.set("host", value);
          },
        },
        records: {
          load: async () => [...scope.records.values()],
          write: async (id, value) => {
            if (value === null) scope.records.delete(id);
            else scope.records.set(id, value);
          },
        },
      };
    },
    grants: {
      load: async () => grants,
      save: async (next) => {
        grants = structuredClone(next);
      },
    },
  };
}

/** A daemon that accepts the stubbed single-use ticket instead of a token. */
class TicketDaemon extends FakeDaemon {
  override accepts(offered: { token?: string | undefined; ticket?: string | undefined }) {
    return offered.ticket === TICKET;
  }
}

function daemonBridge(): ExpoPinnedBridge {
  return {
    pinnedFetch: async (input) => {
      if (input.method === "POST" && input.path === "/v1/pair")
        return { status: 200, body: JSON.stringify(credential()) };
      if (input.path === "/v1/tickets") {
        return {
          status: 200,
          body: JSON.stringify({ ticket: TICKET, expiresAt: Date.now() + 60_000 }),
        };
      }
      return { status: 404, body: "{}" };
    },
    pinnedSocketOpen: () => {},
    pinnedSocketSend: () => {},
    pinnedSocketClose: () => {},
    addSocketListener: () => () => {},
  };
}

async function until(
  done: () => boolean,
  message = "Timed out waiting for the daemon.",
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (done()) return;
    if (Date.now() - started > 15_000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function pairLive(daemon: FakeDaemon, sent: string[]) {
  const produced = createProductionStartup({
    bridge: daemonBridge(),
    credentials: createMemoryCredentialStore(),
    directoryStorage: memoryStorage(),
    database: memoryDatabase(),
    identityReader: async () => ({ hostId: "host-1", displayName: "Studio", version: "1.0" }),
    transportFor: () => {
      const inner = fakeTransport(daemon);
      return {
        open: (events) => inner.open(events),
        send: (text) => {
          sent.push(text);
          inner.send(text);
        },
        close: () => inner.close(),
      };
    },
  });
  expect(await produced.load()).toEqual([]);
  daemon.createThread({ id: THREAD, workspaceId: "ace", title: "T", provider: "codex" });
  const confirmed = preparePairing(LINK);
  await produced.pair(confirmed, "My phone");
  expect(produced.canOperate("host-1")).toBe(true);
  return produced;
}

function seedApproval(daemon: FakeDaemon): string {
  daemon.apply(THREAD, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "appr-1",
      blocking: true,
      request: {
        kind: "approval",
        title: "Run the migration?",
        options: [
          { id: "allow", label: "Allow once", kind: "allow_once" },
          { id: "deny", label: "Deny", kind: "deny" },
        ],
      },
    },
  ]);
  const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(THREAD) });
  if (view?.kind !== "thread") throw new Error("Thread snapshot unavailable.");
  const id = Object.values(view.interactions)[0]?.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("Seeded approval missing.");
  return id;
}

function seedQuestion(daemon: FakeDaemon): string {
  daemon.apply(THREAD, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "ques-1",
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "colour",
            text: "Which colour?",
            options: [
              { id: "red", label: "Red" },
              { id: "blue", label: "Blue" },
            ],
            multiSelect: false,
            allowOther: false,
            secret: false,
          },
        ],
      },
    },
  ]);
  const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(THREAD) });
  if (view?.kind !== "thread") throw new Error("Thread snapshot unavailable.");
  const id = Object.values(view.interactions)[0]?.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("Seeded question missing.");
  return id;
}

it("builds the existing interaction.resolve contract for approvals and questions", () => {
  expect(buildApprovalResolvePayload("appr-1", "allow")).toEqual({
    type: "interaction.resolve",
    interactionId: "appr-1",
    resolution: { kind: "approval", optionId: "allow" },
  });
  expect(buildQuestionResolvePayload("ques-1", { colour: ["red"] })).toEqual({
    type: "interaction.resolve",
    interactionId: "ques-1",
    resolution: { kind: "question", answers: { colour: ["red"] } },
  });
  expect(buildQuestionResolvePayload("ques-1", {}, true)).toEqual({
    type: "interaction.resolve",
    interactionId: "ques-1",
    resolution: { kind: "question", answers: {}, dismissed: true },
  });
});

it("fails the act check closed and maps thrown failures without internals", () => {
  expect(productionMayAct(true)).toBe(true);
  expect(productionMayAct(false)).toBe(false);
  expect(productionAnswerFailureCopy(new ViewOnlyError())).toMatch(/view only/i);
  expect(productionAnswerFailureCopy(new Error("This machine is not connected."))).toBe(
    "This machine is not connected.",
  );
  expect(productionAnswerFailureCopy(new Error("boom"))).toBe("Answer could not be saved.");
  expect(productionApprovalRefusalCopy("already_resolved")).toBe(
    "Already answered on another device.",
  );
  expect(productionQuestionRefusalCopy("not_found")).toBe("This request no longer exists.");
  expect(productionApprovalRefusalCopy("bogus-code")).toBe("This approval could not be answered");
  expect(productionQuestionRefusalCopy(undefined)).toBe("These questions could not be answered");
});

it("admits a real approval through a fresh gate and closes the daemon request", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const approvalId = seedApproval(daemon);
    const receipt = await resolveProductionApproval(produced, "host-1", approvalId, "allow");
    expect(receipt.ok).toBe(true);
    expect(sent.some((text) => text.includes("interaction.resolve"))).toBe(true);
    // The daemon closed the request: the read lease reports it resolved.
    const lease = produced.runtimeForReading("host-1").thread(THREAD);
    try {
      await until(() => lease.store.interaction(approvalId)?.state === "resolved");
    } finally {
      lease.release();
    }
  } finally {
    await produced.disconnectAll();
  }
});

it("admits a real question answer through a fresh gate", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const questionId = seedQuestion(daemon);
    const receipt = await resolveProductionQuestion(produced, "host-1", questionId, {
      colour: ["blue"],
    });
    expect(receipt.ok).toBe(true);
    expect(sent.some((text) => text.includes("interaction.resolve"))).toBe(true);
    const lease = produced.runtimeForReading("host-1").thread(THREAD);
    try {
      await until(() => lease.store.interaction(questionId)?.state === "resolved");
    } finally {
      lease.release();
    }
  } finally {
    await produced.disconnectAll();
  }
});

it("refuses a view-only approval before touching the wire", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const approvalId = seedApproval(daemon);
    await produced.grants.setScopes("device-1", ["read"]);
    expect(produced.canOperate("host-1")).toBe(false);
    expect(productionMayAct(produced.canOperate("host-1"))).toBe(false);
    const before = sent.length;
    await expect(
      resolveProductionApproval(produced, "host-1", approvalId, "allow"),
    ).rejects.toBeInstanceOf(ViewOnlyError);
    expect(sent.length).toBe(before);
  } finally {
    await produced.disconnectAll();
  }
});

it("a resolver closed over before revocation still fails at send time", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const approvalId = seedApproval(daemon);
    // The UI holds no gate: the closure only names the machine and request
    // and resolves admission inside the call, so revoking first still refuses.
    const submit = () => resolveProductionApproval(produced, "host-1", approvalId, "allow");
    await produced.grants.setScopes("device-1", ["read"]);
    const before = sent.length;
    await expect(submit()).rejects.toBeInstanceOf(ViewOnlyError);
    expect(sent.slice(before).some((text) => text.includes("interaction.resolve"))).toBe(false);
  } finally {
    await produced.disconnectAll();
  }
});

it("an unknown host fails closed with nothing on the wire", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const before = sent.length;
    await expect(resolveProductionApproval(produced, "nope", "appr-1", "allow")).rejects.toThrow();
    expect(sent.length).toBe(before);
  } finally {
    await produced.disconnectAll();
  }
});

it("a cached resolver fails after removal instead of reaching the next owner", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const submit = () => resolveProductionApproval(produced, "host-1", "appr-1", "allow");
    await produced.remove("host-1");
    const before = sent.length;
    await expect(submit()).rejects.toThrow();
    expect(sent.slice(before).some((text) => text.includes("interaction.resolve"))).toBe(false);
  } finally {
    await produced.disconnectAll();
  }
});

it("a second tap while sending is dropped: first answer wins", () => {
  const id = "prod-review-lock-sending";
  expect(canResolveInteraction("pending", isResolutionLocked(id), true)).toBe(true);
  markResolutionSending(id);
  expect(canResolveInteraction("pending", isResolutionLocked(id), true)).toBe(false);
});

it("keeps only pending cardable ids for the strip, in order and deduped", () => {
  expect(
    pendingProductionInteractionIds([
      { id: "a1", state: "pending", request: { kind: "approval" } },
      { id: "q1", state: "pending", request: { kind: "question" } },
      { id: "p1", state: "pending", request: { kind: "plan_review" } },
      { id: "f1", state: "pending", request: { kind: "elicitation" } },
      { id: "a1", state: "pending", request: { kind: "approval" } },
      { id: "done", state: "resolved", request: { kind: "approval" } },
      { id: "browser", state: "pending", request: { kind: "browser_help" } },
      undefined,
    ]),
  ).toEqual(["a1", "q1", "p1", "f1"]);
  expect(isCardableProductionInteraction(undefined)).toBe(false);
  expect(
    isCardableProductionInteraction({ state: "pending", request: { kind: "elicitation" } }),
  ).toBe(true);
  expect(
    isCardableProductionInteraction({ state: "pending", request: { kind: "plan_review" } }),
  ).toBe(true);
  expect(
    isCardableProductionInteraction({ state: "pending", request: { kind: "browser_help" } }),
  ).toBe(false);
  expect(
    isCardableProductionInteraction({ state: "resolved", request: { kind: "approval" } }),
  ).toBe(false);
});

it("suppresses only the read-only copy the live strip already covers", () => {
  const covered = new Set(["a1"]);
  expect(
    shouldSuppressProductionReadOnly(
      { id: "a1", state: "pending", request: { kind: "approval" } },
      covered,
    ),
  ).toBe(true);
  expect(
    shouldSuppressProductionReadOnly(
      { id: "q9", state: "pending", request: { kind: "question" } },
      covered,
    ),
  ).toBe(false);
  expect(
    shouldSuppressProductionReadOnly(
      { id: "a1", state: "resolved", request: { kind: "approval" } },
      covered,
    ),
  ).toBe(false);
  expect(
    shouldSuppressProductionReadOnly(
      { id: "p9", state: "pending", request: { kind: "plan_review" } },
      covered,
    ),
  ).toBe(false);
  expect(
    shouldSuppressProductionReadOnly(
      { id: "a1", state: "pending", request: { kind: "plan_review" } },
      new Set(["a1"]),
    ),
  ).toBe(true);
  expect(
    shouldSuppressProductionReadOnly(
      { id: "f1", state: "pending", request: { kind: "elicitation" } },
      new Set(["f1"]),
    ),
  ).toBe(true);
  expect(shouldSuppressProductionReadOnly(undefined, covered)).toBe(false);
});

it("tap-time admission rechecks the current grant instead of trusting render state", () => {
  expect(canTapProductionCard("pending", false, true)).toBe(true);
  expect(canTapProductionCard("pending", false, false)).toBe(false);
  expect(canTapProductionCard("pending", true, true)).toBe(false);
  expect(canTapProductionCard("resolved", false, true)).toBe(false);
  expect(currentProductionGrant(() => true, "host-1")).toBe(true);
  expect(currentProductionGrant(() => false, "host-1")).toBe(false);
  expect(
    currentProductionGrant(() => {
      throw new Error("gone");
    }, "host-1"),
  ).toBe(false);
});

it("a grant revoked after mount still fails closed at the gate with nothing on the wire", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const approvalId = seedApproval(daemon);
    expect(produced.canOperate("host-1")).toBe(true);
    expect(
      canTapProductionCard(
        "pending",
        false,
        currentProductionGrant((id) => produced.canOperate(id), "host-1"),
      ),
    ).toBe(true);
    await produced.grants.setScopes("device-1", ["read"]);
    expect(produced.canOperate("host-1")).toBe(false);
    expect(
      canTapProductionCard(
        "pending",
        false,
        currentProductionGrant((id) => produced.canOperate(id), "host-1"),
      ),
    ).toBe(false);
    const before = sent.length;
    await expect(
      resolveProductionApproval(produced, "host-1", approvalId, "allow"),
    ).rejects.toBeInstanceOf(ViewOnlyError);
    expect(sent.length).toBe(before);
    const lease = produced.runtimeForReading("host-1").thread(THREAD);
    try {
      await until(() => lease.store.interaction(approvalId) !== undefined);
      expect(lease.store.interaction(approvalId)?.state).toBe("pending");
      expect(
        pendingProductionInteractionIds([
          lease.store.interaction(approvalId) === undefined
            ? undefined
            : {
                id: approvalId,
                state: lease.store.interaction(approvalId)?.state ?? "resolved",
                request: {
                  kind: lease.store.interaction(approvalId)?.request.kind ?? "approval",
                },
              },
        ]),
      ).toEqual([approvalId]);
    } finally {
      lease.release();
    }
  } finally {
    await produced.disconnectAll();
  }
});

it("a stale render-time grant never admits after revocation: fresh check wins", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const questionId = seedQuestion(daemon);
    const renderedActing = true;
    expect(canTapProductionCard("pending", false, renderedActing)).toBe(true);
    await produced.grants.setScopes("device-1", ["read"]);
    const fresh = currentProductionGrant((id) => produced.canOperate(id), "host-1");
    expect(fresh).toBe(false);
    expect(canTapProductionCard("pending", false, fresh)).toBe(false);
    const before = sent.length;
    await expect(
      resolveProductionQuestion(produced, "host-1", questionId, { colour: ["red"] }),
    ).rejects.toBeInstanceOf(ViewOnlyError);
    expect(sent.length).toBe(before);
  } finally {
    await produced.disconnectAll();
  }
});

it("keeps interleaved ledger order so the strip renders [question, approval] as-is", () => {
  expect(
    pendingProductionInteractionIds([
      { id: "q1", state: "pending", request: { kind: "question" } },
      { id: "a1", state: "pending", request: { kind: "approval" } },
    ]),
  ).toEqual(["q1", "a1"]);
});

it("a daemon close between render and tap refuses on fresh state with no lock side effects", () => {
  // Render saw pending, but a fresh store read sees resolved: the tap must
  // refuse even though the grant still holds.
  const pendingStore = { interaction: () => ({ state: "pending" }) };
  const resolvedStore = { interaction: () => ({ state: "resolved" }) };
  const missingStore = { interaction: () => undefined };
  const deadStore = {
    interaction: () => {
      throw new Error("pin failed");
    },
  };
  expect(freshProductionInteractionState(pendingStore, "a1")).toBe("pending");
  expect(freshProductionInteractionState(resolvedStore, "a1")).toBe("resolved");
  expect(freshProductionInteractionState(missingStore, "a1")).toBe(undefined);
  expect(freshProductionInteractionState(deadStore, "a1")).toBe(undefined);
  // Fresh resolved/missing never admits, even with a live grant and no lock.
  expect(canTapFreshProductionCard("resolved", false, true)).toBe(false);
  expect(canTapFreshProductionCard(undefined, false, true)).toBe(false);
  expect(canTapFreshProductionCard("pending", false, true)).toBe(true);
  expect(canTapFreshProductionCard("pending", true, true)).toBe(false);
  expect(canTapFreshProductionCard("cancelled", false, true)).toBe(false);
  expect(canTapFreshProductionCard("expired", false, true)).toBe(false);
});

it("leaves browser_help as read-only: never carded, never suppressed", () => {
  expect(
    isCardableProductionInteraction({ state: "pending", request: { kind: "browser_help" } }),
  ).toBe(false);
  expect(
    shouldSuppressProductionReadOnly(
      { id: "x1", state: "pending", request: { kind: "browser_help" } },
      new Set(["x1"]),
    ),
  ).toBe(false);
  expect(
    pendingProductionInteractionIds([
      { id: "plan", state: "pending", request: { kind: "plan_review" } },
      { id: "form", state: "pending", request: { kind: "elicitation" } },
      { id: "help", state: "pending", request: { kind: "browser_help" } },
      { id: "a1", state: "pending", request: { kind: "approval" } },
    ]),
  ).toEqual(["plan", "form", "a1"]);
});

it("a malformed interaction id fails before admission with nothing on the wire", async () => {
  expect(() => buildApprovalResolvePayload("", "allow")).toThrow();
  let gates = 0;
  const stub = {
    runtimeForMutation: () => {
      gates += 1;
      return { command: async () => ({ ok: true }) };
    },
    canOperate: () => true,
  } as unknown as Parameters<typeof resolveProductionApproval>[0];
  await expect(resolveProductionApproval(stub, "host-1", "", "allow")).rejects.toThrow();
  await expect(resolveProductionQuestion(stub, "host-1", "", {})).rejects.toThrow();
  await expect(resolveProductionPlanReview(stub, "host-1", "", "approve")).rejects.toThrow();
  expect(gates).toBe(0);
});

it("builds the existing interaction.resolve contract for plan reviews", () => {
  expect(buildPlanReviewResolvePayload("plan-1", "approve")).toEqual({
    type: "interaction.resolve",
    interactionId: "plan-1",
    resolution: { kind: "plan_review", decision: "approve" },
  });
  expect(buildPlanReviewResolvePayload("plan-1", "reject", " Keep PIDs out ")).toEqual({
    type: "interaction.resolve",
    interactionId: "plan-1",
    resolution: { kind: "plan_review", decision: "reject", feedback: "Keep PIDs out" },
  });
  expect(planReviewResolution("reject", "  ")).toBe(undefined);
  expect(planReviewResolution("reject")).toBe(undefined);
  expect(() => buildPlanReviewResolvePayload("plan-1", "reject", "  ")).toThrow();
  expect(productionPlanRefusalCopy("already_resolved")).toBe("Already answered on another device.");
  expect(productionPlanRefusalCopy("bogus")).toBe("This plan could not be answered");
});

it("builds the existing interaction.resolve contract for elicitations", () => {
  const form = {
    kind: "elicitation",
    server: "deploy",
    message: "Where?",
    mode: "form",
    schema: {
      type: "object",
      properties: { region: { type: "string", enum: ["eu", "us"] } },
      required: ["region"],
    },
  } as const;
  expect(elicitationMode({ mode: undefined, url: "https://example.com/x" })).toBe("url");
  expect(elicitationMode({ mode: undefined, url: undefined })).toBe("form");
  expect(
    elicitationUnsupported({
      ...form,
      schema: { type: "object", properties: { deep: { type: "object" } } },
    }),
  ).toBe(true);
  expect(
    elicitationUnsupported({ kind: "elicitation", server: "s", message: "m", mode: "url" }),
  ).toBe(true);
  expect(buildElicitationResolvePayload("form-1", form, "decline")).toEqual({
    type: "interaction.resolve",
    interactionId: "form-1",
    resolution: { kind: "elicitation", action: "decline" },
  });
  expect(buildElicitationResolvePayload("form-1", form, "accept", { region: "eu" })).toEqual({
    type: "interaction.resolve",
    interactionId: "form-1",
    resolution: { kind: "elicitation", action: "accept", content: { region: "eu" } },
  });
  // Reject before the wire: missing required, out-of-schema values, unknown keys.
  expect(elicitationResolution(form, "accept", {})).toBe(undefined);
  expect(elicitationResolution(form, "accept", { region: "xx" })).toBe(undefined);
  expect(elicitationResolution(form, "accept", { region: "eu", other: "x" })).toBe(undefined);
  expect(() => buildElicitationResolvePayload("form-1", form, "accept", {})).toThrow();
  expect(submittedElicitationValues({ a: "  x  ", b: "   " })).toEqual({ a: "x" });
  // Consent pages accept only with a safe address.
  const page = {
    kind: "elicitation",
    server: "s",
    message: "m",
    mode: "url",
    url: "https://example.com ok",
  } as const;
  expect(elicitationResolution({ ...page, url: "https://example.com/ok" }, "accept")).toEqual({
    kind: "elicitation",
    action: "accept",
  });
  expect(elicitationResolution(page, "accept")).toBe(undefined);
  expect(productionElicitationRefusalCopy("not_found")).toBe("This request no longer exists.");
  expect(productionElicitationRefusalCopy(undefined)).toBe("This request could not be answered");
});

function seedPlanReview(daemon: FakeDaemon): string {
  daemon.apply(THREAD, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "plan-1",
      blocking: true,
      request: { kind: "plan_review", title: "Ship it", markdown: "Do it" },
    },
  ]);
  const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(THREAD) });
  if (view?.kind !== "thread") throw new Error("Thread snapshot unavailable.");
  const id = Object.values(view.interactions)[0]?.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("Seeded plan missing.");
  return id;
}

function seedElicitation(daemon: FakeDaemon): string {
  daemon.apply(THREAD, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "form-1",
      blocking: true,
      request: {
        kind: "elicitation",
        server: "deploy",
        message: "Where should it deploy?",
        mode: "form",
        schema: {
          type: "object",
          properties: { region: { type: "string", enum: ["eu", "us"] } },
          required: ["region"],
        },
      },
    },
  ]);
  const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(THREAD) });
  if (view?.kind !== "thread") throw new Error("Thread snapshot unavailable.");
  const id = Object.values(view.interactions)[0]?.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("Seeded form missing.");
  return id;
}

it("admits a real plan review through a fresh gate and closes the daemon request", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const planId = seedPlanReview(daemon);
    const receipt = await resolveProductionPlanReview(produced, "host-1", planId, "approve");
    expect(receipt.ok).toBe(true);
    expect(sent.some((text) => text.includes("interaction.resolve"))).toBe(true);
    const lease = produced.runtimeForReading("host-1").thread(THREAD);
    try {
      await until(() => lease.store.interaction(planId)?.state === "resolved");
    } finally {
      lease.release();
    }
  } finally {
    await produced.disconnectAll();
  }
});

it("a plan rejection without feedback fails before admission with nothing on the wire", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const planId = seedPlanReview(daemon);
    const before = sent.length;
    await expect(
      resolveProductionPlanReview(produced, "host-1", planId, "reject", "   "),
    ).rejects.toThrow();
    expect(sent.length).toBe(before);
    const lease = produced.runtimeForReading("host-1").thread(THREAD);
    try {
      await until(() => lease.store.interaction(planId) !== undefined);
      expect(lease.store.interaction(planId)?.state).toBe("pending");
    } finally {
      lease.release();
    }
  } finally {
    await produced.disconnectAll();
  }
});

it("admits a real elicitation answer through a fresh gate", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const formId = seedElicitation(daemon);
    const lease = produced.runtimeForReading("host-1").thread(THREAD);
    let request: ElicitationRequest | undefined;
    try {
      await until(() => lease.store.interaction(formId) !== undefined);
      const row = lease.store.interaction(formId);
      if (row?.request.kind !== "elicitation") throw new Error("Seeded form missing.");
      request = row.request;
    } finally {
      lease.release();
    }
    if (!request || request.kind !== "elicitation") throw new Error("Seeded form missing.");
    const receipt = await resolveProductionElicitation(
      produced,
      "host-1",
      formId,
      request,
      "accept",
      {
        region: "us",
      },
    );
    expect(receipt.ok).toBe(true);
    expect(sent.some((text) => text.includes("interaction.resolve"))).toBe(true);
  } finally {
    await produced.disconnectAll();
  }
});

it("refuses a view-only plan answer before touching the wire", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const planId = seedPlanReview(daemon);
    await produced.grants.setScopes("device-1", ["read"]);
    const before = sent.length;
    await expect(
      resolveProductionPlanReview(produced, "host-1", planId, "approve"),
    ).rejects.toBeInstanceOf(ViewOnlyError);
    expect(sent.length).toBe(before);
  } finally {
    await produced.disconnectAll();
  }
});

it("exposes only a safe consent address for the tappable link", () => {
  expect(consentLink({ url: "https://example.com/consent" })).toBe("https://example.com/consent");
  expect(consentLink({ url: undefined })).toBe(undefined);
  expect(consentLink({ url: "javascript:alert(1)" })).toBe(undefined);
  expect(consentLink({ url: "https://user:pass@example.com/" })).toBe(undefined);
  expect(consentLink({ url: "not a url" })).toBe(undefined);
});

it("opens the consent page safely and fails visibly without throwing", async () => {
  const opened: string[] = [];
  const notices: string[] = [];
  const notify = (text: string): void => {
    notices.push(text);
  };
  // A safe address reaches the opener with no notice.
  expect(
    await openConsentPage(
      { url: "https://example.com/consent" },
      async (url) => {
        opened.push(url);
        return true;
      },
      notify,
    ),
  ).toBe(true);
  expect(opened).toEqual(["https://example.com/consent"]);
  expect(notices).toEqual([]);
  // Unsafe addresses never reach the opener and stay silent: the card
  // already tells the person to decline those.
  const before = opened.length;
  expect(await openConsentPage({ url: "javascript:alert(1)" }, async () => true, notify)).toBe(
    false,
  );
  expect(opened.length).toBe(before);
  expect(notices).toEqual([]);
  // A refused open notifies instead of throwing.
  expect(
    await openConsentPage({ url: "https://example.com/consent" }, async () => false, notify),
  ).toBe(false);
  expect(notices).toEqual([consentLinkFailureCopy]);
  // A throwing opener notifies too.
  expect(
    await openConsentPage(
      { url: "https://example.com/consent" },
      async () => {
        throw new Error("no browser");
      },
      notify,
    ),
  ).toBe(false);
  expect(notices).toEqual([consentLinkFailureCopy, consentLinkFailureCopy]);
});

it("an unsafe consent page still declines: decline and cancel always fit", () => {
  const unsafe = {
    kind: "elicitation",
    server: "s",
    message: "m",
    mode: "url",
    url: "javascript:alert(1)",
  } as const;
  expect(elicitationUnsupported(unsafe)).toBe(true);
  expect(elicitationResolution(unsafe, "accept")).toBe(undefined);
  expect(elicitationResolution(unsafe, "decline")).toEqual({
    kind: "elicitation",
    action: "decline",
  });
  expect(elicitationResolution(unsafe, "cancel")).toEqual({
    kind: "elicitation",
    action: "cancel",
  });
});

it("an invalid elicitation accept names the problem and never reaches the wire", async () => {
  // Matches the iOS bridge refusal so the tap notifies instead of a silent no-op.
  expect(elicitationInvalidCopy).toBe("That doesn't fit the request. Check what you entered.");
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const formId = seedElicitation(daemon);
    const lease = produced.runtimeForReading("host-1").thread(THREAD);
    let request: ElicitationRequest | undefined;
    try {
      await until(() => lease.store.interaction(formId) !== undefined);
      const row = lease.store.interaction(formId);
      if (row?.request.kind !== "elicitation") throw new Error("Seeded form missing.");
      request = row.request;
    } finally {
      lease.release();
    }
    if (!request || request.kind !== "elicitation") throw new Error("Seeded form missing.");
    const before = sent.length;
    await expect(
      resolveProductionElicitation(produced, "host-1", formId, request, "accept", {
        region: "xx",
      }),
    ).rejects.toThrow();
    expect(sent.length).toBe(before);
    const check = produced.runtimeForReading("host-1").thread(THREAD);
    try {
      await until(() => check.store.interaction(formId) !== undefined);
      expect(check.store.interaction(formId)?.state).toBe("pending");
    } finally {
      check.release();
    }
  } finally {
    await produced.disconnectAll();
  }
});
