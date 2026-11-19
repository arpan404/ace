import {
  MachineDescription,
  MachineSpadeResult,
  maxSpadeResponseBytes,
  type MachineCallOrigin,
  type SpadeInboxRequest,
  type SpadeMachine,
  type SpadeRemoteOutcome,
} from "@ace/protocol";
import type { MachineDirectory } from "../machines/directory.ts";
import { MachineFailure } from "../machines/transport.ts";

/** How long a describe may take before the machine is listed offline. */
const describeMs = 4000;
/** An inbox `answer` long-polls up to 25 s there; the rest is room for the hop and Spade. */
const inboxMs = 40_000;
/** Spade's answer there (at most 1 MiB) and the call's envelope around it. */
const answerBytes = maxSpadeResponseBytes + 64 * 1024;

export interface SpadeRemoteDeps {
  directory: Pick<MachineDirectory, "linked" | "named" | "label" | "call">;
  /** Who is calling: this machine, as Spade's host thread. */
  origin(): Promise<MachineCallOrigin>;
}

/**
 * Spade's reach to its bots on the person's other machines (ADR 0132): the linked machines this
 * daemon can call, and one inbox request at a time sent to one of them as a `spade` machine call.
 * Nothing is retried here; Spade's outbox retries, keyed so a copy is never delivered twice.
 */
export class SpadeRemote {
  private deps: SpadeRemoteDeps;
  constructor(deps: SpadeRemoteDeps) {
    this.deps = deps;
  }

  /**
   * Each linked machine that lets this one in, online when it describes itself now, offline when
   * it can't be reached. Machines that refuse, and ones never seen with a host id, are left out.
   */
  async machines(): Promise<SpadeMachine[]> {
    const origin = await this.deps.origin();
    const listed = await Promise.all(
      this.deps.directory
        .linked()
        .slice(0, 16)
        .map(async ({ machine, hostId }): Promise<SpadeMachine | undefined> => {
          try {
            const description = MachineDescription.parse(
              await this.deps.directory.call(
                machine,
                origin,
                { op: "describe" },
                { timeoutMs: describeMs },
              ),
            );
            return { hostId: description.hostId, name: description.name, status: "online" };
          } catch (error) {
            const offline = error instanceof MachineFailure && error.kind !== "refused";
            if (!offline || !hostId) return undefined;
            return { hostId, name: this.deps.directory.label(machine), status: "offline" };
          }
        }),
    );
    return listed.flatMap((entry) => (entry ? [entry] : []));
  }

  /** One inbox request for Spade on the machine with that host id, and how it went. */
  async send(hostId: string, request: SpadeInboxRequest): Promise<SpadeRemoteOutcome> {
    const machine = this.deps.directory.named(hostId);
    if (!machine)
      return { kind: "error", code: "unknown_machine", message: "No linked machine has that id." };
    try {
      const answer = MachineSpadeResult.safeParse(
        await this.deps.directory.call(
          machine,
          await this.deps.origin(),
          { op: "spade", request },
          { timeoutMs: inboxMs, maxBytes: answerBytes },
        ),
      );
      if (!answer.success)
        return {
          kind: "error",
          code: "refused",
          message: `${this.deps.directory.label(machine)} answered with something unreadable.`,
        };
      return { kind: "response", status: answer.data.status, body: answer.data.body };
    } catch (error) {
      return this.failed(machine, error);
    }
  }

  private failed(machine: string, error: unknown): SpadeRemoteOutcome {
    const name = this.deps.directory.label(machine);
    if (!(error instanceof MachineFailure) || error.kind === "offline")
      return { kind: "error", code: "offline", message: `${name} can't be reached.` };
    if (error.kind === "disconnected")
      return {
        kind: "error",
        code: "disconnected",
        message: `Lost ${name} after the request was sent; it may have arrived.`,
      };
    const refusal = error.refusal ?? "unavailable";
    const words =
      error.message && error.message !== `Machine refused: ${refusal}` ? error.message : undefined;
    return {
      kind: "error",
      code: "refused",
      message: `${refusal}: ${words ?? `${name} refused the request.`}`.slice(0, 1024),
    };
  }
}
