import type { ClientMessage, DeviceId, ServerMessage } from "@ace/protocol";
import type { MachineAccount } from "./account-access/machine-account.ts";
import type { RemoteAuth } from "./remote-auth.ts";

type Hello = Extract<ClientMessage, { type: "hello" }>;
export type RelayAdmission =
  | {
      device: { id: DeviceId };
      /** For an account device: whether it still holds access (account, machine code). */
      stillAdmitted?: () => boolean;
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
  if (hello.grant !== undefined) {
    const admission = options.account
      ? await options.account.admitDevice({
          grant: hello.grant,
          deviceId: hello.deviceId,
          machineCode: hello.machineCode,
        })
      : ({ admitted: false, code: "unauthorized", message: "Valid hello required" } as const);
    if (!admission.admitted)
      return { refusal: { type: "error", code: admission.code, message: admission.message } };
    const { account } = admission;
    const machine = options.account;
    return {
      device: { id: hello.deviceId },
      stillAdmitted: () => machine?.stillAdmitted(hello.deviceId, account) === true,
    };
  }
  const device =
    hello.ticket !== undefined
      ? options.auth.consume(hello.ticket)
      : hello.token !== undefined
        ? options.auth.deviceBearer(hello.token)
        : undefined;
  if (!device || device.id !== hello.deviceId) return {};
  return { device };
}
