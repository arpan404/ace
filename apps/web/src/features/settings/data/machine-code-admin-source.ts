import { machineCodeAdmin, type ClientApi } from "@ace/client";
import type { MachineAccountAccess } from "@/features/ace-account/index.ts";

const elsewhere = () =>
  Promise.reject(new Error("Sign that machine in or out on the machine itself."));

/**
 * Another machine's machine code over its own connection (`machine.code.*`, ADR 0111). Signing
 * a machine in or out is for that machine alone, so only the code is offered. A device without
 * admin there, or a daemon without ace accounts, shows nothing.
 */
export function machineCodeAdminSource(client: Pick<ClientApi, "request">): MachineAccountAccess {
  const admin = machineCodeAdmin(client);
  const changed = async (result: ReturnType<typeof admin.set>) => {
    const answer = await result;
    if (!answer.ok)
      throw new Error(
        answer.error === "forbidden"
          ? "This device doesn't have administrator access to that machine."
          : answer.error === "busy"
            ? "Another change to the code is still running. Try again in a moment."
            : answer.message || "That machine doesn't have ace accounts.",
      );
    return answer.status;
  };
  return {
    async status() {
      // A daemon from before machine codes doesn't answer; it has no code to show.
      const answer = await admin
        .status({ timeoutMs: 10_000 })
        .catch(() => ({ ok: false, error: "unavailable", message: "" }) as const);
      if (answer.ok) return answer.status;
      if (answer.error === "busy") throw new Error(answer.message);
      return undefined;
    },
    signIn: elsewhere,
    signOut: elsewhere,
    setCode: (code) => changed(admin.set(code)),
    clearCode: () => changed(admin.clear()),
  };
}
