import { PublicToolError, type PublicToolCode } from "@ace/mcp-server";
import {
  MachineDescription,
  type MachineCall,
  type MachineCallOrigin,
  type MachineSummary,
} from "@ace/protocol";
import type { RemoteProfile } from "../cli/profiles.ts";
import { AgentControlError } from "../agent-control/failure.ts";
import {
  MachineFailure,
  type MachineTransport,
  type MachineTransportOptions,
} from "./transport.ts";

export interface DirectoryDeps {
  /** Paired machines from `ace remote add`; their tokens never leave this module's calls. */
  profiles(): RemoteProfile[];
  transport: MachineTransport;
  log(message: string, fields: Record<string, unknown>): void;
}
/** A failure as the calling agent reads it: an authored code and a short reason. */
export interface MachineProblem {
  code: PublicToolCode;
  detail: string;
}

/**
 * The machines this daemon can reach as a paired device. Listing asks each one what it offers
 * this device, so a machine that has not opted in is never shown. Offline machines are listed
 * only after they were seen opted in by this daemon.
 */
export class MachineDirectory {
  private deps: DirectoryDeps;
  private seen = new Map<string, MachineSummary>();
  constructor(deps: DirectoryDeps) {
    this.deps = deps;
  }
  /** The person-facing name of a machine, as it last described itself. */
  label(machine: string): string {
    return this.seen.get(machine)?.name ?? machine;
  }
  async list(origin: MachineCallOrigin): Promise<MachineSummary[]> {
    const profiles = this.deps.profiles().slice(0, 16);
    const listed = await Promise.all(
      profiles.map(async (profile): Promise<MachineSummary | undefined> => {
        try {
          const description = MachineDescription.parse(
            await this.call(profile.name, origin, { op: "describe" }, { timeoutMs: 4000 }),
          );
          const summary: MachineSummary = {
            machine: profile.name,
            name: description.name,
            status: "online",
            access: description.access,
            projects: description.projects,
            tools: description.tools,
            providers: description.providers,
          };
          this.seen.set(profile.name, summary);
          return summary;
        } catch (error) {
          const offline = error instanceof MachineFailure && error.kind !== "refused";
          const known = this.seen.get(profile.name);
          if (!offline) this.seen.delete(profile.name);
          return offline && known
            ? {
                machine: profile.name,
                name: known.name,
                status: "offline",
                next: "Ask the person to wake it and start ace there.",
              }
            : undefined;
        }
      }),
    );
    return listed.flatMap((entry) => (entry ? [entry] : []));
  }
  /** One call as this daemon's paired device; failures become authored, token-free words. */
  async call(
    machine: string,
    origin: MachineCallOrigin,
    call: MachineCall,
    options: MachineTransportOptions,
  ): Promise<unknown> {
    const profile = this.deps.profiles().find((entry) => entry.name === machine);
    const op = call.op === "browser" ? call.tool : call.op;
    if (!profile) {
      this.deps.log("Machine call refused here", { machine, op, outcome: "unknown_machine" });
      throw new MachineFailure("refused", "unauthorized", `No paired machine named ${machine}.`);
    }
    try {
      const result = await this.deps.transport(profile, { origin, call }, options);
      this.deps.log("Machine call to another device", {
        machine,
        op,
        fromThread: origin.threadId,
        outcome: "ok",
      });
      return result;
    } catch (error) {
      const failure = error instanceof MachineFailure ? error : new MachineFailure("offline");
      if (failure.kind === "refused" && failure.refusal !== "invalid" && call.op !== "status")
        this.seen.delete(machine);
      this.deps.log("Machine call to another device failed", {
        machine,
        op,
        fromThread: origin.threadId,
        outcome: failure.refusal ?? failure.kind,
      });
      throw failure;
    }
  }
  problem(machine: string, error: unknown): MachineProblem {
    const name = this.label(machine);
    if (!(error instanceof MachineFailure))
      return { code: "execution_failed", detail: `The call to ${name} failed.` };
    if (error.kind === "offline")
      return { code: "machine_offline", detail: `${name} is offline or unreachable.` };
    if (error.kind === "disconnected")
      return { code: "machine_disconnected", detail: `Lost ${name} during the call.` };
    switch (error.refusal) {
      case "machine_forbidden":
        return { code: "machine_forbidden", detail: error.message.slice(0, 240) };
      case "invalid":
      case "not_found":
        return { code: "invalid_arguments", detail: error.message.slice(0, 240) };
      default:
        return {
          code: "machine_unavailable",
          detail:
            error.refusal === "machine_opted_out" || error.refusal === "unauthorized"
              ? `${name} does not let agents from this machine use it.`
              : error.message.slice(0, 240),
        };
    }
  }
  controlError(machine: string, error: unknown): AgentControlError {
    const problem = this.problem(machine, error);
    return new AgentControlError(problem.code, problem.detail, error, problem.detail);
  }
  toolError(machine: string, error: unknown): PublicToolError {
    const problem = this.problem(machine, error);
    return new PublicToolError(problem.code, undefined, undefined, undefined, problem.detail);
  }
}
