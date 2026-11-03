import { MachineCode, type MachineCodeRefusal } from "@ace/protocol";

/**
 * An account device's credential for one machine (ADR 0111): a fresh device grant for every
 * connection, plus the machine code the person typed when the daemon asks for it. Wire
 * `credential`, `refused` and `welcomed` into a channel; a UI reads `asking` and calls `enter`,
 * then opens the channel again. The code is kept only until the daemon answers it.
 */
export function machineCodeGate(grant: () => Promise<string>) {
  let code: string | undefined;
  let asking: MachineCodeRefusal | undefined;
  let lockedUntil: number | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    async credential(): Promise<{ grant: string; machineCode?: string }> {
      const token = await grant();
      return code === undefined ? { grant: token } : { grant: token, machineCode: code };
    },
    /** The daemon asked for the code, or refused the one sent. */
    refused(reason: MachineCodeRefusal, until?: number): void {
      code = undefined;
      asking = reason;
      lockedUntil = reason === "machine_code_locked" ? until : undefined;
      notify();
    },
    /** The daemon let the device in; the code is not needed again on this machine. */
    welcomed(): void {
      if (code === undefined && asking === undefined) return;
      code = undefined;
      asking = undefined;
      lockedUntil = undefined;
      notify();
    },
    /** Why the UI should ask for the code now, or undefined. */
    get asking(): MachineCodeRefusal | undefined {
      return asking;
    },
    /** With `machine_code_locked`: when code entry opens again (epoch milliseconds). */
    get lockedUntil(): number | undefined {
      return lockedUntil;
    },
    /** The code the person typed, sent with the next connection. Throws when malformed. */
    enter(value: string): void {
      code = MachineCode.parse(value);
      asking = undefined;
      lockedUntil = undefined;
      notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type MachineCodeGate = ReturnType<typeof machineCodeGate>;
