import type { ClientApi } from "@ace/client";
import type { MachineAccountStatus, RemoteAccessStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import type { DaemonEndpoint } from "@/boot/connection.tsx";
import { machineAccountSource } from "./machine-account-source.ts";

const token = "ace0".repeat(16);
const status = (set: boolean): MachineAccountStatus => ({ signedIn: true, machineCode: { set } });
const remote = async (): Promise<RemoteAccessStatus> => ({
  enabled: true,
  transport: "relay",
  listenOverride: null,
  relayOverride: false,
  account: status(false),
});

/** The window's connection, answering `machine.code.*` as the daemon would. */
function connection(sent: string[]): Pick<ClientApi, "request"> {
  let set = false;
  const request = async (input: { type: string }) => {
    sent.push(input.type);
    if (input.type === "machine.code.set") set = true;
    if (input.type === "machine.code.clear") set = false;
    return {
      type: "machine.code.result",
      requestId: "r",
      result: { ok: true, status: status(set) },
    };
  };
  // Only machine-code requests are ever sent through this stub.
  return { request: request as unknown as ClientApi["request"] };
}

/** A daemon's HTTP routes behind an injected fetch, recording what reached them. */
function routes(reached: string[]): DaemonEndpoint {
  return {
    kind: "fake",
    access: {
      origin: "http://127.0.0.1:4242/",
      token: async () => token,
      fetch: async (input, init) => {
        reached.push(`${init?.method} ${new URL(input).pathname}`);
        return new Response(JSON.stringify(status(false)), { status: 200 });
      },
    },
    screen: () => {
      throw new Error("unused");
    },
    devices: () => {
      throw new Error("unused");
    },
  };
}

const relayed = (): DaemonEndpoint => ({
  kind: "daemon",
  deviceId: "phone",
  target: { url: "wss://relay.example/", token, relayHostId: "A".repeat(52) },
});

test("the machine code is set and cleared over the connection, never the HTTP routes", async () => {
  const sent: string[] = [];
  const reached: string[] = [];
  const source = machineAccountSource(routes(reached), remote, connection(sent), {});

  expect((await source.setCode("2468")).machineCode.set).toBe(true);
  expect((await source.clearCode()).machineCode.set).toBe(false);

  expect(sent).toEqual(["machine.code.set", "machine.code.clear"]);
  expect(reached).toEqual([]);
});

test("the account status is the remote access status's, so it reads through a relay", async () => {
  const source = machineAccountSource(relayed(), remote, connection([]), {});

  expect(await source.status()).toEqual(status(false));
});

test("signing in and out stays on this computer's HTTP route", async () => {
  const reached: string[] = [];
  const source = machineAccountSource(routes(reached), remote, connection([]), {});

  await source.signIn("https://acehq.dev", "session");
  await source.signOut();

  expect(reached).toEqual(["PUT /v1/ace-account", "DELETE /v1/ace-account"]);
});

test("a machine reached through a relay can't be signed in or out, and its token never goes to the relay", async () => {
  const original = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = async (input) => {
    fetched.push(String(input));
    return new Response("{}", { status: 200 });
  };
  try {
    const source = machineAccountSource(relayed(), remote, connection([]), {});

    await expect(source.signIn("https://acehq.dev", "session")).rejects.toThrow(
      "Only this computer can sign itself in or out.",
    );
    await expect(source.signOut()).rejects.toThrow("Only this computer");
    expect(fetched).toEqual([]);
  } finally {
    globalThis.fetch = original;
  }
});

test("the desktop app changes its own daemon's account and code through its main process", async () => {
  const asked: string[] = [];
  const sent: string[] = [];
  const desktop = {
    ace: {
      account: {
        machine: async (request: { op: string }) => {
          asked.push(request.op);
          return status(request.op === "setCode");
        },
      },
    },
  };
  const source = machineAccountSource(routes([]), remote, connection(sent), desktop);

  await source.setCode("2468");
  await source.signOut();

  expect(asked).toEqual(["setCode", "signOut"]);
  expect(sent).toEqual([]);
});
