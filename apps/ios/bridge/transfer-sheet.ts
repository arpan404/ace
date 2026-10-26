import { transferRunning } from "@ace/client";
import type { Transfer } from "@ace/protocol";
import {
  refusalWords,
  type Placement,
  type Refusal,
  type TransferMachine,
} from "@ace/ui-core/transfers";
import {
  transferLine,
  type HeldRefusal,
  type Line,
  type LineAct,
  type Subject,
} from "./transfer-lines.ts";

/*
 * The Continue on / Open on sheet's steps, as the web's chooser walks them, and what each step
 * shows. Pure; `transfers.ts` holds the state and Swift draws it.
 */

/** The sheet's steps, as the web's chooser walks them. */
export type Step =
  /** Until this machine's transfer list has answered: one may already be running. */
  | { kind: "checking" }
  | { kind: "machines" }
  | { kind: "options"; machine: { hostId: string; name: string } }
  | {
      kind: "status";
      machine: { hostId: string; name: string };
      /** The choices sent from here; Try again repeats them. */
      placement: Placement | undefined;
      /** The command's id once the daemon took it, or why it refused. */
      started: { commandId: string } | { refused: Refusal } | undefined;
    };

/** The first step once the list is known: a running transfer's line, else the machines. */
export function opening(latest: Transfer | undefined): Step {
  return latest && transferRunning(latest)
    ? {
        kind: "status",
        machine: latest.target,
        placement: undefined,
        started: { commandId: latest.commandId },
      }
    : { kind: "machines" };
}

/**
 * The step after the store changed: the list answering ends "checking", and a transfer that
 * turns up running while the machines show (a reconnect's list, an agent's push) takes their
 * place, so a second transfer is never offered.
 */
export function settle(step: Step, seeded: boolean, latest: Transfer | undefined): Step {
  if (step.kind === "checking") return seeded ? opening(latest) : step;
  if (step.kind === "machines" && latest && transferRunning(latest)) return opening(latest);
  return step;
}

export const verb = (subject: Subject) => (subject.kind === "thread" ? "Continue" : "Open");

/** What the machines step says when it has no machine to offer. */
export function machinesEmpty(
  state: "loading" | "ready" | "failed",
  machines: readonly TransferMachine[],
): string | null {
  if (state === "loading") return "Looking for linked machines…";
  if (state === "failed") return "Couldn't read this machine's links. Try again in a moment.";
  return machines.length
    ? null
    : "No other machines are linked to this one. Link them in Settings › Fleet on your computer.";
}

/** Links as they were last read. */
export interface Links {
  state: "loading" | "ready" | "failed";
  machines: TransferMachine[];
}

const machineRows = (machines: readonly TransferMachine[]) =>
  machines.map((each) => ({ ...each, reason: each.reason ?? null }));

/** What Swift draws for the sheet: its title, what it carries and the current step. */
export function sheetView(
  subject: Subject,
  step: Step,
  context: {
    links: Links;
    ignoredByDefault: boolean;
    /** The transfer the status step follows, once the store has it. */
    transfer: Transfer | undefined;
    lineOptions: { refused?: HeldRefusal | undefined; busy?: LineAct | undefined };
  },
) {
  const action = (name: string) => `${verb(subject)} on ${name}`;
  const base = {
    kind: subject.kind,
    title: `${verb(subject)} on another machine`,
    what: subject.kind === "thread" ? subject.title : subject.name,
  };
  switch (step.kind) {
    case "checking":
      return {
        ...base,
        step: { kind: "checking", words: "Checking what this machine is sending…" },
      };
    case "machines":
      return {
        ...base,
        step: {
          kind: "machines",
          machines: machineRows(context.links.machines),
          empty: machinesEmpty(context.links.state, context.links.machines),
        },
      };
    case "options":
      return {
        ...base,
        step: {
          kind: "options",
          machine: step.machine,
          action: action(step.machine.name),
          ignoredByDefault: context.ignoredByDefault,
        },
      };
    case "status":
      return {
        ...base,
        step: {
          kind: "status",
          machine: step.machine,
          action: action(step.machine.name),
          line: statusLine(step, context.transfer, context.lineOptions),
        },
      };
  }
}

/** The status step's line: the transfer's, else why it was refused, else that it's starting. */
function statusLine(
  step: Extract<Step, { kind: "status" }>,
  transfer: Transfer | undefined,
  options: { refused?: HeldRefusal | undefined; busy?: LineAct | undefined },
): Line {
  if (transfer) return transferLine(transfer, { retry: true, ...options });
  const started = step.started;
  if (started && "refused" in started)
    return {
      transferId: null,
      words: refusalWords(started.refused, step.machine.name),
      alert: true,
      actions: [{ act: "retry", label: "Try again", disabled: false }],
      open: null,
    };
  return {
    transferId: null,
    words: `Getting ready to send to ${step.machine.name}`,
    alert: false,
    actions: [],
    open: null,
  };
}
