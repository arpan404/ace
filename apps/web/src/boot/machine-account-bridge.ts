import { MachineAccountStatus } from "@ace/protocol";

export type MachineAccountRequest =
  | { op: "signIn"; origin: string }
  | { op: "signOut" }
  | { op: "setCode"; code: string }
  | { op: "clearCode" };

/**
 * The desktop app's way to this computer's daemon account routes (`ace.account.machine`), which
 * the daemon serves only to its own credential. Absent in a browser.
 */
export function machineAccountBridge(scope: object = globalThis) {
  const ace: unknown = Reflect.get(scope, "ace");
  if (!ace || typeof ace !== "object") return undefined;
  const account: unknown = Reflect.get(ace, "account");
  if (!account || typeof account !== "object") return undefined;
  const machine: unknown = Reflect.get(account, "machine");
  if (typeof machine !== "function") return undefined;
  return async (request: MachineAccountRequest) =>
    MachineAccountStatus.parse(await machine(request));
}
