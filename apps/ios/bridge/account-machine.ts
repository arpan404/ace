import { ClientError, machineCodeGate, type MachineCodeGate } from "@ace/client";
import { HostCallError } from "@ace/native-host";
import { MachineCodeRefusal } from "@ace/protocol";
import { z } from "zod";

/**
 * A machine on the phone's ace account (ADR 0111). Swift's relay socket fetches a fresh device
 * grant for every connection; the hello presents that grant, and the machine code while the
 * daemon asks for one. The code lives only in the gate, until the daemon answers it.
 */
export function accountGate(credential: () => Promise<string>): MachineCodeGate {
  const gate = machineCodeGate(
    async () =>
      z.strictObject({ grant: z.string().min(1) }).parse(JSON.parse(await credential())).grant,
  );
  // A typed code waiting for its answer. A `machine_code_required` arriving meanwhile answers an
  // attempt that left before the code was typed; it must not throw the code away.
  let pending = false;
  return {
    credential: () => gate.credential(),
    refused(reason, until) {
      if (pending && reason === "machine_code_required") return;
      pending = false;
      gate.refused(reason, until);
    },
    welcomed() {
      pending = false;
      gate.welcomed();
    },
    get asking() {
      return gate.asking;
    },
    get lockedUntil() {
      return gate.lockedUntil;
    },
    enter(value) {
      gate.enter(value);
      pending = true;
    },
    subscribe: (listener) => gate.subscribe(listener),
  };
}

/** The gate's credential, failing the way the SDK retries: offline retries, the rest is final. */
export function accountCredential(gate: MachineCodeGate) {
  return async (): Promise<{ grant: string; machineCode?: string }> => {
    try {
      return await gate.credential();
    } catch (error) {
      if (error instanceof HostCallError && error.code === "offline")
        throw new ClientError("offline");
      throw new ClientError("auth");
    }
  };
}

const Refusal = z.object({
  type: z.literal("error"),
  code: MachineCodeRefusal,
  lockedUntil: z.number().int().positive().optional(),
});

/**
 * Why the daemon refused this hello, when a message says so; undefined otherwise. Only the first
 * messages of a socket are offered here, so the cost never grows with the stream.
 */
export function machineCodeRefusal(
  text: string,
): { reason: MachineCodeRefusal; lockedUntil?: number } | undefined {
  if (text.length > 4096 || !text.includes("machine_code_")) return undefined;
  try {
    const parsed = Refusal.safeParse(JSON.parse(text));
    if (!parsed.success) return undefined;
    const { code, lockedUntil } = parsed.data;
    return lockedUntil === undefined ? { reason: code } : { reason: code, lockedUntil };
  } catch {
    return undefined;
  }
}
