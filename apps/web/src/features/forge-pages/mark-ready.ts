import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ForgeHostedLifecycleCommand, type ForgePrRow } from "@ace/protocol";
import { actionErrorText } from "@ace/ui-core";
import { useToast } from "@/components/ui/toast.tsx";
import { CommandRefused, runCommand } from "@/lib/daemon-command.ts";
import { readForge } from "@/lib/forge-read.ts";

/**
 * Mark ready from a list row: read the pull request's lifecycle as GitHub has it now, so the
 * write names the version it was chosen from, then mark it ready for review and read the lists
 * again. A pull request changed elsewhere, or one this account may no longer mark ready, says so.
 */
export function useMarkReady() {
  const client = useClient();
  const cache = useQueryClient();
  const toast = useToast();
  return async (project: string, row: ForgePrRow): Promise<boolean> => {
    const pr = row.ref;
    try {
      const read = await readForge(
        client,
        {
          op: "forge.pr.lifecycle",
          workspaceId: project,
          repository: pr.repository,
          number: pr.number,
        },
        AbortSignal.timeout(30_000),
      );
      if (read.resource !== "prLifecycle") throw new Error("No PR lifecycle response.");
      const snapshot = read.value.snapshot;
      if (!snapshot.actions.includes("ready")) {
        toast.info({
          title: `#${pr.number} can't be marked ready here`,
          description: "Open it to see why.",
        });
        return false;
      }
      const result = await runCommand(
        client,
        ForgeHostedLifecycleCommand.parse({
          type: "forge.hosted.lifecycle",
          workspaceId: project,
          pr,
          operation: {
            kind: "apply",
            expectedVersion: snapshot.version,
            action: { kind: "ready" },
          },
        }),
      );
      const accepted = result.forgeLifecycle?.outcome === "accepted";
      if (accepted) toast.success({ title: `#${pr.number} is ready for review` });
      else toast.info({ title: `Marking #${pr.number} ready: waiting for GitHub` });
      return accepted;
    } catch (error) {
      toast.error({
        title: `Couldn't mark #${pr.number} ready`,
        description:
          error instanceof CommandRefused
            ? actionErrorText(error.code)
            : "Try again from its page.",
      });
      return false;
    } finally {
      void cache.invalidateQueries({ queryKey: ["forge", project, "browse"] });
    }
  };
}
