import type { ClonePhase, ProjectProblem } from "@ace/ui-core";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import type { Machine } from "@/lib/machines.ts";
import { projectFailure, useProjectCommandsOn, type Added } from "./project-commands.ts";

export interface CloneInput {
  parent: string;
  name: string;
  url: string;
}

export type CloneRun =
  | { status: "idle" }
  | {
      status: "running";
      commandId: string;
      input: CloneInput;
      machine: Machine;
      phase: ClonePhase;
      percent: number | undefined;
      cancelling: boolean;
      /** Why Cancel didn't take, when it didn't. */
      cancelProblem?: string | undefined;
    }
  | {
      status: "failed";
      input: CloneInput;
      machine: Machine;
      problem: ProjectProblem & { code: string };
    };

/**
 * One clone at a time, held above the dialog so it carries on when the dialog closes: on the
 * machine it started on, its progress from that machine's pushes (matched by the command id
 * chosen here, which stays the same for the whole clone), Cancel, Retry and how it ended.
 * Finishing with the dialog closed says so in a toast that opens the project.
 */
export function useCloneRun(options: {
  visible: boolean;
  onCloned(result: Added, machine: Machine): void;
}) {
  const commandsOn = useProjectCommandsOn();
  const toast = useToast();
  const [run, setRun] = useState<CloneRun>({ status: "idle" });
  const current = useRef<{ commandId: string; stop(): void } | undefined>(undefined);
  const visible = useRef(options.visible);
  const onCloned = useRef(options.onCloned);
  useEffect(() => {
    visible.current = options.visible;
    onCloned.current = options.onCloned;
  });
  useEffect(() => () => current.current?.stop(), []);

  const finish = () => {
    current.current?.stop();
    current.current = undefined;
  };

  const start = (input: CloneInput, machine: Machine) => {
    if (current.current) return;
    const commands = commandsOn(machine);
    const commandId = `clone-${crypto.randomUUID()}`;
    const stop = commands.onCloneProgress((progress) => {
      if (progress.commandId !== commandId) return;
      setRun((previous) =>
        previous.status === "running" && previous.commandId === commandId
          ? { ...previous, phase: progress.phase, percent: progress.percent }
          : previous,
      );
    });
    current.current = { commandId, stop };
    setRun({
      status: "running",
      commandId,
      input,
      machine,
      phase: "starting",
      percent: undefined,
      cancelling: false,
    });
    commands.clone(input, commandId).then(
      (result) => {
        finish();
        setRun({ status: "idle" });
        if (!visible.current)
          toast.add({
            title: `Cloned ${result.project.name}`,
            actionProps: { children: "Open", onClick: () => onCloned.current(result, machine) },
          });
        else onCloned.current(result, machine);
      },
      (error: unknown) => {
        finish();
        const problem = projectFailure(error);
        setRun(
          problem.code === "clone_cancelled"
            ? { status: "idle" }
            : { status: "failed", input, machine, problem },
        );
        if (!visible.current && problem.code !== "clone_cancelled")
          toast.add({ title: `Couldn't clone ${input.name}`, description: problem.message });
      },
    );
  };

  const cancel = () => {
    if (run.status !== "running" || run.cancelling) return;
    setRun({ ...run, cancelling: true, cancelProblem: undefined });
    // The clone's own receipt ends the run; a cancel that came too late leaves it finishing.
    commandsOn(run.machine)
      .cancelClone(run.commandId)
      .catch((error: unknown) => {
        const problem = projectFailure(error);
        setRun((previous) =>
          previous.status === "running"
            ? {
                ...previous,
                cancelling: false,
                cancelProblem:
                  problem.code === "clone_not_running"
                    ? "Too late to cancel: the clone is finishing."
                    : problem.message,
              }
            : previous,
        );
      });
  };

  /** The failed clone again, with the same address, folder and machine. */
  const retry = () => {
    if (run.status === "failed") start(run.input, run.machine);
  };
  const dismiss = () =>
    setRun((previous) => (previous.status === "failed" ? { status: "idle" } : previous));
  return { run, start, cancel, retry, dismiss };
}

export type CloneControl = ReturnType<typeof useCloneRun>;
