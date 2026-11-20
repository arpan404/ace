import type { AceAccount } from "@ace/protocol/ace-account";
import {
  MachineCode,
  type ClientMessage,
  type MachineAccountStatus,
  type MachineCodeResult,
  type ServerMessage,
} from "@ace/protocol";

/**
 * This machine's ace account and machine code (ADR 0111) in memory: one state behind the HTTP
 * routes a fake serves and `machine.code.*` over the wire, as a daemon's `MachineAccount` is.
 * Starts signed out with no code and no owner. The app signing it in stands for the person's
 * first proof (ADR 0190 §3a): the first account to do so owns it until it lets it go.
 */
export class FakeMachineAccount {
  private state: MachineAccountStatus = {
    signedIn: false,
    machineCode: { set: false },
    owner: null,
  };
  status(): MachineAccountStatus {
    return this.state;
  }
  signIn(origin: string, account: AceAccount): MachineAccountStatus {
    this.state = {
      ...this.state,
      signedIn: true,
      origin,
      account,
      owner: this.state.owner ?? { account: account.id },
    };
    return this.state;
  }
  signOut(): MachineAccountStatus {
    this.state = {
      signedIn: false,
      machineCode: this.state.machineCode,
      owner: this.state.owner ?? null,
    };
    return this.state;
  }
  /** The owner let it go: nobody owns it until the next sign-in. */
  releaseOwner(): void {
    this.state = { ...this.state, owner: null };
  }
  /** Undefined when `code` isn't a machine code (4 to 128 characters). */
  setCode(code: unknown): MachineAccountStatus | undefined {
    if (!MachineCode.safeParse(code).success) return undefined;
    this.state = { ...this.state, machineCode: { set: true } };
    return this.state;
  }
  clearCode(): MachineAccountStatus {
    this.state = { ...this.state, machineCode: { set: false } };
    return this.state;
  }
}

/** `machine.code.*` against `account`; a machine without ace accounts answers `unavailable`. */
export function answerMachineCode(
  account: FakeMachineAccount | undefined,
  message: ClientMessage,
  push: (message: ServerMessage) => void,
): boolean {
  if (message.type === "account.owner.release") {
    account?.releaseOwner();
    push({ type: "account.owner.release.result", requestId: message.requestId, ok: !!account });
    return true;
  }
  if (
    message.type !== "machine.code.status" &&
    message.type !== "machine.code.set" &&
    message.type !== "machine.code.clear"
  )
    return false;
  const answer = (): MachineCodeResult["result"] => {
    if (!account)
      return { ok: false, error: "unavailable", message: "ace account is unavailable." };
    if (message.type === "machine.code.status") return { ok: true, status: account.status() };
    if (message.type === "machine.code.clear") return { ok: true, status: account.clearCode() };
    // The wire schema already holds the code to 4 to 128 characters.
    const status = account.setCode(message.code);
    return status
      ? { ok: true, status }
      : { ok: false, error: "unavailable", message: "Couldn't set the code." };
  };
  push({ type: "machine.code.result", requestId: message.requestId, result: answer() });
  return true;
}
