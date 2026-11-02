/*
 * ace accounts in the fake mode and tests (ADR 0111): the daemon's account and machine-code
 * routes in memory, an account backend that is already signed in with a few machines, and an
 * account machine that asks for its machine code (2468) before it opens.
 */
import type { AccessOptions } from "@ace/client";
import { machineCodeGate } from "@ace/client";
import { aceAccountClient } from "@ace/client/ace-account";
import type { MachineAccountStatus, MachineCodeRefusal } from "@ace/protocol";
import { MachineCode } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";

const person = { id: "user_fake", email: "arpan@example.com", name: "Arpan Bhandari" };
const fakeOrigin = "https://account.example.com";

const json = (status: number, body: unknown) => Response.json(body, { status });
const read = async (init: RequestInit) => {
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(String(init.body)));
  } catch {
    return {};
  }
};

/**
 * Serves `/v1/ace-account` and `/v1/machine-code` beside the fake daemon's other access routes,
 * and adds the account to `/v1/status`, as a daemon with ace accounts does. Starts signed out
 * with no code; five wrong codes from the fake account machine don't touch this one.
 */
export function withFakeMachineAccount(access: AccessOptions): AccessOptions {
  let state: MachineAccountStatus = { signedIn: false, machineCode: { set: false } };
  return {
    ...access,
    async fetch(input, init) {
      const path = new URL(input).pathname;
      const method = init.method ?? "GET";
      if (path === "/v1/status") {
        const response = await access.fetch(input, init);
        if (!response.ok) return response;
        const body = z
          .object({ remoteAccess: z.record(z.string(), z.unknown()) })
          .parse(await response.json());
        return json(200, { ...body, remoteAccess: { ...body.remoteAccess, account: state } });
      }
      if (path === "/v1/ace-account") {
        if (method === "GET") return json(200, state);
        if (method === "PUT") {
          const body = await read(init);
          if (typeof body.token !== "string") return json(400, { error: "Invalid ace session" });
          state = { ...state, signedIn: true, origin: String(body.origin), account: person };
          return json(200, state);
        }
        if (method === "DELETE") {
          state = { signedIn: false, machineCode: state.machineCode };
          return json(200, state);
        }
      }
      if (path === "/v1/machine-code") {
        if (method === "PUT") {
          const code = MachineCode.safeParse((await read(init)).code);
          if (!code.success) return json(400, { error: "A machine code has 4 to 128 characters." });
          state = { ...state, machineCode: { set: true } };
          return json(200, state);
        }
        if (method === "DELETE") {
          state = { ...state, machineCode: { set: false } };
          return json(200, state);
        }
      }
      return access.fetch(input, init);
    },
  };
}

const hostIds = {
  studio: "STUDIOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  laptop: "LAPTOPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

/** An account backend already signed in as the fake person, listing two machines. */
export function fakeAccountBackend(storage: KeyValueStorage, now: () => number) {
  const token = "f".repeat(43);
  const session = { token, expiresAt: now() + 30 * 86_400_000, account: person };
  storage.setItem(`ace.account.session:${fakeOrigin}`, JSON.stringify(session));
  let machines = [
    { hostId: hostIds.studio, name: "Studio", platform: "darwin", lastSeenAt: now() - 120_000 },
    {
      hostId: hostIds.laptop,
      name: "Travel laptop",
      platform: "linux",
      lastSeenAt: now() - 3 * 86_400_000,
    },
  ];
  const client = aceAccountClient({
    origin: fakeOrigin,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      if (path === "/v1/account/session" && method === "GET")
        return Response.json({ account: person, expiresAt: session.expiresAt });
      if (path === "/v1/account/session" && method === "DELETE") return Response.json({ ok: true });
      if (path === "/v1/machines" && method === "GET") return Response.json({ machines });
      const forget = path.match(/^\/v1\/machines\/([A-Z2-7]{52})$/)?.[1];
      if (forget && method === "DELETE") {
        machines = machines.filter((machine) => machine.hostId !== forget);
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unavailable" }, { status: 503 });
    },
  });
  return { origin: fakeOrigin, client, storage };
}

/**
 * Opens fake account machines after a short wait: the Studio asks for its machine code (2468)
 * and locks code entry for 15 minutes after five wrong ones; any other opens at once.
 */
export function fakeAccountConnector(now: () => number) {
  let wrong = 0;
  let lockedUntil: number | undefined;
  return {
    connect(hostId: string) {
      type State =
        | { kind: "connecting" }
        | { kind: "asking"; lockedUntil?: number | undefined }
        | { kind: "open" }
        | { kind: "failed"; message: string };
      const gate = machineCodeGate(async () => "fake-grant");
      const listeners = new Set<() => void>();
      let state: State = { kind: "connecting" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const set = (next: State) => {
        state = next;
        for (const listener of listeners) listener();
      };
      const refuse = (reason: MachineCodeRefusal) => {
        gate.refused(reason);
        set({ kind: "asking", lockedUntil });
      };
      const open = () => {
        set({ kind: "connecting" });
        clearTimeout(timer);
        timer = setTimeout(() => {
          void gate.credential().then(({ machineCode }) => {
            if (hostId !== hostIds.studio) return set({ kind: "open" });
            if (lockedUntil !== undefined && lockedUntil > now())
              return refuse("machine_code_locked");
            if (machineCode === undefined) return refuse("machine_code_required");
            if (machineCode !== "2468") {
              wrong += 1;
              if (wrong >= 5) {
                wrong = 0;
                lockedUntil = now() + 15 * 60_000;
                return refuse("machine_code_locked");
              }
              return refuse("machine_code_wrong");
            }
            gate.welcomed();
            set({ kind: "open" });
          });
        }, 400);
      };
      open();
      return {
        gate,
        get: () => state,
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
        retry: open,
        close: () => clearTimeout(timer),
      };
    },
  };
}
