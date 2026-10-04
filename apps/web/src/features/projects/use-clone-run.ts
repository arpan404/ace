import { useClient } from "@ace/client-react";
import type { ClonePhase, ProjectProblem } from "@ace/ui-core";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { projectFailure, useProjectCommands, type Added } from "./project-commands.ts";

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
      phase: ClonePhase;
      percent: number | undefined;
      cancelling: boolean;
      /** Why Cancel didn't take, when it didn't. */
      cancelProblem?: string | undefined;
    }
  | { status: "failed"; input: CloneInput; problem: ProjectProblem & { code: string } };

/**
 * One clone at a time, held above the dialog so it carries on when the dialog closes: its
 * progress from the daemon's pushes (matched by the command id chosen here, which stays the
 * same for the whole clone), Cancel, and how it ended. Finishing with the dialog closed says so
 * in a toast that opens the project.
 */
export function useCloneRun(options: { visible: boolean; onCloned(result: Added): void }) {
  const client = useClient();
  const commands = useProjectCommands();
  const toast = useToast();
  const [run, setRun] = useState<CloneRun>({ status: "idle" });
  const current = useRef<string | undefined>(undefined);
  const visible = useRef(options.visible);
  const onCloned = useRef(options.onCloned);
  useEffect(() => {
    visible.current = options.visible;
    onCloned.current = options.onCloned;
  });

  useEffect(
    () =>
      client.projects.onCloneProgress((progress) => {
        if (progress.commandId !== current.current) return;
        setRun((previous) =>
          previous.status === "running" && previous.commandId === progress.commandId
            ? { ...previous, phase: progress.phase, percent: progress.percent }
            : previous,
        );
      }),
    [client],
  );

  const start = (input: CloneInput) => {
    if (current.current) return;
    const commandId = `clone-${crypto.randomUUID()}`;
    current.current = commandId;
    setRun({
      status: "running",
      commandId,
      input,
      phase: "starting",
      percent: undefined,
      cancelling: false,
    });
    commands.clone(input, commandId).then(
      (result) => {
        current.current = undefined;
        setRun({ status: "idle" });
        if (!visible.current)
          toast.add({
            title: `Cloned ${result.project.name}`,
            actionProps: { children: "Open", onClick: () => onCloned.current(result) },
          });
        else onCloned.current(result);
      },
      (error: unknown) => {
        current.current = undefined;
        const problem = projectFailure(error);
        setRun(
          problem.code === "clone_cancelled"
            ? { status: "idle" }
            : { status: "failed", input, problem },
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
    commands.cancelClone(run.commandId).catch((error: unknown) => {
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

  const dismiss = () =>
    setRun((previous) => (previous.status === "failed" ? { status: "idle" } : previous));
  return { run, start, cancel, dismiss };
}

export type CloneControl = ReturnType<typeof useCloneRun>;
