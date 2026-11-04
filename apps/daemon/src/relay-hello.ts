import type { ClientMessage, DeviceId, ServerMessage } from "@ace/protocol";
import type { MachineAccount } from "./account-access/machine-account.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import type { Device } from "./devices.ts";

type Hello = Extract<ClientMessage, { type: "hello" }>;
export type RelayAdmission =
  | {
      device: { id: DeviceId };
      /** For an account device: whether it still holds access (account, machine code). */
      stillAdmitted?: () => boolean;
      /** For an account device: the ace account its grant names. */
      account?: string;
      /** For an account device: when its grant runs out, unless the socket refreshes it. */
      grantExpiresAt?: number;
      refusal?: undefined;
    }
  | { device?: undefined; refusal?: Extract<ServerMessage, { type: "error" }> };

/**
 * Who a relayed hello authenticates. Relay credentials are paired-device tokens, one-use
 * tickets, or a device grant on this machine's ace account (ADR 0111); never the host token.
 * A grant refusal is answered with a typed error so the client can ask for the machine code.
 */
export async function relayHello(
  hello: Hello,
  options: { auth: RemoteAuth; account?: MachineAccount | undefined },
): Promise<RelayAdmission> {
  // An account grant wins over a paired token: a signed-in device is admin (ADR 0114).
  if (hello.grant !== undefined) return accountHello(hello, hello.grant, options.account);
  const device =
    hello.ticket !== undefined
      ? options.auth.consume(hello.ticket)
      : hello.token !== undefined
        ? options.auth.deviceBearer(hello.token)
        : undefined;
  // As on a direct socket: the client stops instead of retrying a credential that won't work.
  if (!device || device.id !== hello.deviceId)
    return { refusal: { type: "error", code: "unauthorized", message: "Valid hello required" } };
  return { device };
}

/**
 * Who a hello's ace account device grant admits, on any path: the machine checks the grant,
 * its account and the machine code (`admitDevice`, ADR 0111), and the device keeps access only
 * while `stillAdmitted` holds. A refusal is a typed error so the client can ask for the code.
 */
export async function accountHello(
  hello: Hello,
  grant: string,
  machine: MachineAccount | undefined,
): Promise<RelayAdmission> {
  const admission = machine
    ? await machine.admitDevice({
        grant,
        deviceId: hello.deviceId,
        machineCode: hello.machineCode,
      })
    : ({ admitted: false, code: "unauthorized", message: "Valid hello required" } as const);
  if (!admission.admitted) {
    // A locked machine says until when, so the device can show the time left.
    const lockedUntil =
      admission.code === "machine_code_locked"
        ? machine?.status().machineCode.lockedUntil
        : undefined;
    return {
      refusal: {
        type: "error",
        code: admission.code,
        message: admission.message,
        ...(lockedUntil === undefined ? {} : { lockedUntil }),
      },
    };
  }
  const { account, expiresAt } = admission;
  return {
    device: { id: hello.deviceId },
    account,
    grantExpiresAt: expiresAt,
    stillAdmitted: () => machine?.stillAdmitted(hello.deviceId, account) === true,
  };
}

/** An admitted account device: admin while it stays admitted, never revoked by device id. */
export function accountDeviceActor(id: DeviceId, now: number): Device & { revocable: boolean } {
  return {
    id,
    name: "ace account device",
    scopes: ["admin"],
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
    revocable: false,
  };
}
