import { useRef, useState } from "react";
import { useClient } from "@ace/client-react";
import {
  ForgeHostedPrCreateCommand,
  WorkspaceId,
  type ForgeCompare,
  type ForgeCompareHead,
  type ForgePrRef,
} from "@ace/protocol";
import { actionErrorText } from "@ace/ui-core";
import { useToast } from "@/components/ui/toast.tsx";
import { runCommand } from "@/lib/daemon-command.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { failureCode, readForge } from "@/lib/forge-read.ts";

/** Where a new PR of `project` opens, its branches on both sides, and the template. */
export function useNewPrContext(project: string) {
  return useDaemonQuery({
    queryKey: ["forge", project, "new-pr", "context"],
    retry: false,
    staleTime: 30_000,
    read: async (reader, signal) => {
      const result = await readForge(
        reader,
        { op: "forge.pr.new-context", workspaceId: project },
        signal,
      );
      if (result.resource !== "newPrContext") throw new Error("No branches returned.");
      return result.value;
    },
  });
}

/** One page of what `head` brings into `base`; nothing is read until both are picked. */
export function useCompare(
  project: string,
  base: string,
  head: ForgeCompareHead | undefined,
  page: number,
  /** The head is in the base's repository, where a branch can't compare with itself. */
  sameRepository = true,
) {
  return useDaemonQuery<ForgeCompare>({
    queryKey: ["forge", project, "new-pr", "compare", base, head?.owner, head?.branch, page],
    enabled: head !== undefined && !(sameRepository && head.branch === base),
    retry: false,
    staleTime: 15_000,
    read: async (reader, signal) => {
      if (!head) throw new Error("No branch picked.");
      const result = await readForge(
        reader,
        { op: "forge.compare", workspaceId: project, base, head, page },
        signal,
      );
      if (result.resource !== "compare") throw new Error("No comparison returned.");
      return result.value;
    },
  });
}

/**
 * Open the pull request. GitHub returns the branch's open PR into that base instead of a second
 * one; details GitHub refused are said once the PR exists.
 */
export function useCreatePr(project: string) {
  const client = useClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  // State lags a render behind: two submits in one tick both see "not pending". This doesn't.
  const inFlight = useRef(false);
  return {
    pending,
    async run(
      input: Omit<ForgeHostedPrCreateCommand, "type" | "workspaceId">,
    ): Promise<ForgePrRef | undefined> {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setPending(true);
      try {
        const result = await runCommand(
          client,
          ForgeHostedPrCreateCommand.parse({
            type: "forge.hosted.pr.create",
            workspaceId: WorkspaceId.parse(project),
            ...input,
          }),
        );
        if (!result.pr) throw new Error("action_outcome_uncertain");
        if (result.prExisting)
          toast.info({ title: `This branch already has pull request #${result.pr.number}` });
        else if (result.code)
          toast.warning({
            title: `Opened pull request #${result.pr.number}`,
            description: actionErrorText(result.code),
          });
        return result.pr;
      } catch (error) {
        toast.error({
          title: "Couldn't open the pull request",
          description: actionErrorText(failureCode(error) ?? "action_outcome_uncertain"),
        });
        return undefined;
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
  };
}
