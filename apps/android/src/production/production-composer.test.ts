import { expect, it } from "vitest";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import type { Storage } from "@ace/client";
import type { ExpoPinnedBridge } from "../security/expo-bridge.ts";
import { createMemoryCredentialStore } from "../pairing/credentials.ts";
import { preparePairing } from "../pairing/pairing-flow.ts";
import { ComposerDraft } from "../composer-draft.ts";
import { ThreadDraftStore, draftKey, memoryDraftPersistence } from "../thread-drafts.ts";
import {
  buildThreadSendPayload,
  canShowProductionComposer,
  productionSavedCopy,
  productionSendFailureCopy,
  sendProductionMessage,
} from "./production-composer.ts";
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

it("shows the composer only when the phone may operate on a paired thread", () => {
  expect(canShowProductionComposer({ canOperate: true, routePaired: true })).toBe(true);
  expect(canShowProductionComposer({ canOperate: false, routePaired: true })).toBe(false);
  expect(canShowProductionComposer({ canOperate: true, routePaired: false })).toBe(false);
  expect(canShowProductionComposer({ canOperate: true, routePaired: true, archived: true })).toBe(
    false,
  );
});

it("builds a text-only steer payload and rejects an invalid thread id", () => {
  const payload = buildThreadSendPayload(THREAD, "steer the agent");
  expect(payload.type).toBe("thread.send");
  expect(payload.delivery).toBe("steer");
  expect(payload.input).toEqual([{ type: "text", text: "steer the agent" }]);
  expect(() => buildThreadSendPayload("", "words")).toThrow();
});

it("maps send failures without leaking internals", () => {
  expect(productionSendFailureCopy(new ViewOnlyError())).toMatch(/view only/i);
  expect(productionSendFailureCopy(new Error("This machine is not connected."))).toBe(
    "This machine is not connected.",
  );
  expect(productionSendFailureCopy(new Error("boom"))).toBe(
    "Message could not be saved. Your draft is still here.",
  );
  expect(productionSavedCopy("ready")).toBe("Message saved");
  expect(productionSavedCopy("connecting")).toBe("Will send when reconnected");
});

it("admits a real thread.send through a fresh gate and clears the draft", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const backing = new ThreadDraftStore(memoryDraftPersistence());
    await backing.open();
    const key = draftKey("host-1", THREAD);
    const model = new ComposerDraft(async (text) => {
      await sendProductionMessage(produced, "host-1", THREAD, text);
    });
    model.follow(key, backing);
    model.edit("steer the agent");
    await until(
      () => backing.textFor(key) === "steer the agent",
      "Timed out waiting for the draft write.",
    );
    await model.send();
    await until(() => sent.some((text) => text.includes("thread.send")));
    expect(model.selection.getSnapshot().text).toBe("");
    expect(backing.textFor(key)).toBe("");
  } finally {
    await produced.disconnectAll();
  }
});

it("refuses a view-only send before touching the wire and keeps the draft", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    await produced.grants.setScopes("device-1", ["read"]);
    expect(produced.canOperate("host-1")).toBe(false);
    expect(
      canShowProductionComposer({ canOperate: produced.canOperate("host-1"), routePaired: true }),
    ).toBe(false);

    const backing = new ThreadDraftStore(memoryDraftPersistence());
    await backing.open();
    const key = draftKey("host-1", THREAD);
    let calls = 0;
    const model = new ComposerDraft(async (text) => {
      calls += 1;
      await sendProductionMessage(produced, "host-1", THREAD, text);
    });
    model.follow(key, backing);
    model.edit("kept words");
    await expect(model.send()).rejects.toBeInstanceOf(ViewOnlyError);
    expect(calls).toBe(1);
    expect(model.selection.getSnapshot().text).toBe("kept words");
    expect(backing.textFor(key)).toBe("kept words");
    expect(sent.some((text) => text.includes("thread.send"))).toBe(false);
    expect(productionSendFailureCopy(new ViewOnlyError())).toMatch(/view only/i);
  } finally {
    await produced.disconnectAll();
  }
});

it("a submit closure made before revocation still fails at send time", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    // The UI holds no gate: the closure only names the machine and thread and
    // resolves admission inside the call, so revoking first still refuses.
    const submit = (text: string) => sendProductionMessage(produced, "host-1", THREAD, text);
    await produced.grants.setScopes("device-1", ["read"]);
    const before = sent.length;
    await expect(submit("late words")).rejects.toBeInstanceOf(ViewOnlyError);
    expect(sent.slice(before).some((text) => text.includes("thread.send"))).toBe(false);
  } finally {
    await produced.disconnectAll();
  }
});

it("whitespace never resolves a gate or touches the wire", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    await produced.grants.setScopes("device-1", ["read"]);
    const before = sent.length;
    // Even view-only, empty text returns before admission: no gate, no wire.
    await expect(sendProductionMessage(produced, "host-1", THREAD, "   \n  ")).resolves.toBe(
      "empty",
    );
    expect(sent.length).toBe(before);
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
    await expect(sendProductionMessage(produced, "nope", THREAD, "words")).rejects.toThrow();
    expect(sent.length).toBe(before);
  } finally {
    await produced.disconnectAll();
  }
});

it("a cached submitter fails after removal instead of reaching the next owner", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const submit = (text: string) => sendProductionMessage(produced, "host-1", THREAD, text);
    await produced.remove("host-1");
    const before = sent.length;
    await expect(submit("late words")).rejects.toThrow();
    expect(sent.slice(before).some((text) => text.includes("thread.send"))).toBe(false);
  } finally {
    await produced.disconnectAll();
  }
});

it("draft words stay scoped to one machine and thread", async () => {
  const backing = new ThreadDraftStore(memoryDraftPersistence());
  await backing.open();
  await backing.save("half a thought", draftKey("host-1", THREAD));
  expect(backing.textFor(draftKey("host-1", THREAD))).toBe("half a thought");
  expect(backing.textFor(draftKey("host-1", "other"))).toBe("");
  expect(backing.textFor(draftKey("other-host", THREAD))).toBe("");
});
