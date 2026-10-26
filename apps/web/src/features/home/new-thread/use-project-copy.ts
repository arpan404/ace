import { transferCancellable } from "@ace/client";
import { HostId, WorkspaceId, type Transfer } from "@ace/protocol";
import { refusalWords, runningWords } from "@ace/ui-core/transfers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { folderName } from "@ace/ui-core";
import { rememberProject } from "@/lib/project-cache.ts";
import { useEffect, useRef, useState } from "react";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { useMachines, useScopedMachine, type Machine } from "@/lib/machines.ts";

/*
 * New thread on a machine that doesn't have the project yet (ADR 0102): sending first carries
 * the project there from the machine that has it, as Open on does (ADR 0101), then starts the
 * thread in the copy. The machine with the project sends it; this one only watches.
 */

export type ProjectCopy =
  | { state: "idle" }
  | { state: "copying"; words: string; cancel: (() => void) | undefined }
  | { state: "failed"; words: string };

const commandId = () => `new-thread-copy-${crypto.randomUUID()}`;

/** The machine `id` names, `primaryMachineId` included. */
const machineOf = (machines: readonly Machine[], id: string | undefined) =>
  id === undefined ? undefined : machines.find((each) => each.id === id);

/** The project's name on the machine it comes from, for the page to call it by. */
export function useSourceProjectName(from: string | undefined, project: string) {
  const source = machineOf(useMachines(), from);
  const client = source?.client;
  return useQuery({
    queryKey: ["new-thread-copy", "name", from, project],
    enabled: client !== undefined,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!client) return null;
      const reply = await client.request(
        { type: "workspace.request", operation: { op: "workspaces.list", limit: 100 } },
        { signal },
      );
      const result = reply.result;
      if (result.kind !== "workspaces") return null;
      return result.workspaces.find((each) => each.id === project)?.name ?? null;
    },
  }).data;
}

/**
 * Carry `project` from machine `from` to this page's machine (host id `to`). `run` resolves
 * with the project's id here once it has landed, or undefined when it failed or was cancelled
 * (the state says why).
 */
export function useProjectCopy(from: string | undefined, project: string, to: string) {
  const machines = useMachines();
  const queryClient = useQueryClient();
  const projectName = useSourceProjectName(from, project);
  const source = machineOf(machines, from);
  const scoped = useScopedMachine();
  const identity = useMachineIdentity();
  const here = scoped?.name ?? identity.name;
  const [copy, setCopy] = useState<ProjectCopy>({ state: "idle" });
  const flight = useRef<{ stop(): void; settle(id: string | undefined): void } | undefined>(
    undefined,
  );
  // Leaving the page hands the message back; the copy itself carries on over there.
  useEffect(() => () => flight.current?.settle(undefined), []);

  const run = (): Promise<string | undefined> => {
    const client = source?.client;
    if (!from || flight.current) return Promise.resolve(undefined);
    if (!client) {
      setCopy({
        state: "failed",
        words: `${source?.name ?? "The machine with this project"} isn't connected. Try again once it's back.`,
      });
      return Promise.resolve(undefined);
    }
    const id = commandId();
    // Seen from here, both machines are named: "This Mac isn't linked to Build server".
    const why = (code: string | undefined, detail: string | undefined) =>
      code === "machine_not_linked"
        ? `${source.name} isn't linked to ${here}. Link them in Settings › Fleet.`
        : refusalWords({ code, detail }, here);
    return new Promise((resolve) => {
      let latest: Transfer | undefined;
      const settle = (landed: string | undefined, next: ProjectCopy) => {
        if (flight.current !== current) return;
        flight.current = undefined;
        stop();
        setCopy(next);
        resolve(landed);
      };
      const cancel = () => {
        if (latest && transferCancellable(latest))
          void client.transfers.cancel(latest.transferId).catch(() => {});
      };
      const stop = client.transfers.onProgress((transfer) => {
        if (transfer.commandId !== id) return;
        latest = transfer;
        if (transfer.phase === "completed") {
          // This machine's list has the copy at once, so the new thread is named for it.
          const landed = transfer.result;
          if (landed)
            rememberProject(queryClient, {
              id: landed.workspaceId,
              name: projectName ?? folderName(landed.path),
              path: landed.path,
            });
          settle(landed?.workspaceId, { state: "idle" });
        } else if (transfer.phase === "cancelled") settle(undefined, { state: "idle" });
        else if (transfer.phase === "failed")
          settle(undefined, {
            state: "failed",
            words: why(transfer.error?.code, transfer.error?.message),
          });
        else
          setCopy({
            state: "copying",
            words: runningWords(transfer),
            cancel: transferCancellable(transfer) ? cancel : undefined,
          });
      });
      const current = {
        stop,
        settle: (landed: string | undefined) => settle(landed, { state: "idle" }),
      };
      flight.current = current;
      setCopy({ state: "copying", words: `Getting ready to send to ${here}`, cancel: undefined });
      client.transfers
        .openOn(
          { workspaceId: WorkspaceId.parse(project), hostId: HostId.parse(to) },
          undefined,
          id,
        )
        .then(
          (result) => {
            if (!result.ok)
              settle(undefined, {
                state: "failed",
                words: why(result.code ?? result.error, result.detail),
              });
          },
          () =>
            settle(undefined, {
              state: "failed",
              words: `Couldn't reach ${source.name}. Try again once it's back.`,
            }),
        );
    });
  };
  /** `from`'s name, for saying where the project comes from. */
  return { copy, run, source: source?.name };
}
