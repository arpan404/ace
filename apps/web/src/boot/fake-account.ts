/*
 * ace accounts in the fake mode and tests (ADR 0111): the daemon's account and machine-code
 * routes in memory, an account backend that is already signed in with a few machines, and an
 * account machine that asks for its machine code (2468) before it opens.
 */
import type { AccessOptions } from "@ace/client";
import { machineCodeGate } from "@ace/client";
import { aceAccountClient } from "@ace/client/ace-account";
import type { AccountMachineState } from "@ace/client-worker/machines";
import type { FakeMachineAccount } from "@ace/fake-daemon";
import type { MachineCodeRefusal } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";

const person = { id: "user_fake", email: "arpan@example.com", name: "Arpan Bhandari" };
export const fakeOrigin = "https://account.example.com";

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
 * from the same account the fake daemon reports in its status and changes over `machine.code.*`,
 * as a daemon with ace accounts does. Five wrong codes from the fake account machine don't touch
 * this one.
 */
export function withFakeMachineAccount(
  access: AccessOptions,
  account: FakeMachineAccount,
): AccessOptions {
  return {
    ...access,
    async fetch(input, init) {
      const path = new URL(input).pathname;
      const method = init.method ?? "GET";
      if (path === "/v1/ace-account") {
        if (method === "GET") return json(200, account.status());
        if (method === "PUT") {
          const body = await read(init);
          if (typeof body.token !== "string") return json(400, { error: "Invalid ace session" });
          return json(200, account.signIn(String(body.origin), person));
        }
        if (method === "DELETE") return json(200, account.signOut());
      }
      if (path === "/v1/machine-code") {
        if (method === "PUT") {
          const status = account.setCode((await read(init)).code);
          return status
            ? json(200, status)
            : json(400, { error: "A machine code has 4 to 128 characters." });
        }
        if (method === "DELETE") return json(200, account.clearCode());
      }
      return access.fetch(input, init);
    },
  };
}

export const fakeHostIds = {
  studio: "STUDIOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  laptop: "LAPTOPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

/** An account backend already signed in as the fake person, listing two machines. */
export function fakeAccountBackend(storage: KeyValueStorage, now: () => number) {
  const token = "f".repeat(43);
  const session = { token, expiresAt: now() + 30 * 86_400_000, account: person };
  storage.setItem(`ace.account.session:${fakeOrigin}`, JSON.stringify(session));
  let machines = [
    { hostId: fakeHostIds.studio, name: "Studio", platform: "darwin", lastSeenAt: now() - 120_000 },
    {
      hostId: fakeHostIds.laptop,
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
 * The fake Studio's machine code (2468): five wrong ones lock code entry for 15 minutes. Any
 * other fake machine has none. `check` says why a code is refused, or undefined to let it in.
 */
export function fakeMachineCodes(now: () => number) {
  let wrong = 0;
  let lockedUntil: number | undefined;
  return {
    get lockedUntil() {
      return lockedUntil;
    },
    check(hostId: string, code: string | undefined): MachineCodeRefusal | undefined {
      if (hostId !== fakeHostIds.studio) return undefined;
      if (lockedUntil !== undefined && lockedUntil > now()) return "machine_code_locked";
      if (code === undefined) return "machine_code_required";
      if (code === "2468") return undefined;
      wrong += 1;
      if (wrong < 5) return "machine_code_wrong";
      wrong = 0;
      lockedUntil = now() + 15 * 60_000;
      return "machine_code_locked";
    },
  };
}

/**
 * Opens fake account machines beside the window's machine after a short wait: the Studio asks
 * for its machine code (`fakeMachineCodes`); any other opens at once.
 */
export function fakeAccountConnector(now: () => number) {
  const codes = fakeMachineCodes(now);
  return {
    async connect(machine: { hostId: string }) {
      const gate = machineCodeGate(async () => "fake-grant");
      const listeners = new Set<() => void>();
      let state: AccountMachineState = { kind: "connecting" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const set = (next: AccountMachineState) => {
        state = next;
        for (const listener of listeners) listener();
      };
      const open = () => {
        set({ kind: "connecting" });
        clearTimeout(timer);
        timer = setTimeout(() => {
          void gate.credential().then(({ machineCode }) => {
            const refused = codes.check(machine.hostId, machineCode);
            if (refused) {
              gate.refused(refused, codes.lockedUntil);
              return set({ kind: "asking", reason: refused, lockedUntil: codes.lockedUntil });
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
        enter(code: string) {
          gate.enter(code);
          open();
        },
        async close() {
          clearTimeout(timer);
        },
      };
    },
  };
}
