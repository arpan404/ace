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
  buildQuestionResolvePayload,
  productionAnswerFailureCopy,
  productionApprovalRefusalCopy,
  productionMayAct,
  productionQuestionRefusalCopy,
  resolveProductionApproval,
  resolveProductionQuestion,
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
