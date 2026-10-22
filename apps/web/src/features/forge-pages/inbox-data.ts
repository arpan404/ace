import { useClient, useConnectionState } from "@ace/client-react";
import { WorkspaceId, type ForgeInboxList, type ForgeInboxWrite } from "@ace/protocol";
import { actionErrorText } from "@ace/ui-core";
import { keepPreviousData, useQueries, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/toast.tsx";
import { CommandRefused, runCommand } from "@/lib/daemon-command.ts";
import { failureCode, readForge } from "@/lib/forge-read.ts";
import { repositoryFromParam } from "@/lib/pull-request-route.ts";
import { afterWrite, inboxQuery, visibleRows, type InboxSearch } from "./inbox-model.ts";

/** Every inbox page of a project, whatever its filters: a write changes them all. */
export const inboxKey = (project: string | undefined) => ["forge", project, "inbox"] as const;

/**
 * The inbox's first `pages` pages of 50. The first is asked for again at GitHub's poll interval
 * while the app is in front, never in the background; the daemon answers repeats from GitHub's
 * 304, so an unchanged inbox costs nothing against the rate limit.
 */
export function useInboxPages(project: string | undefined, search: InboxSearch, pages: number) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const filters = inboxQuery(search, 1);
  const results = useQueries({
    queries: Array.from({ length: pages }, (_, index) => ({
      queryKey: [...inboxKey(project), { ...filters, page: 0 }, index + 1],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const value = await readForge(
          client,
          {
            op: "forge.inbox.list",
            workspaceId: project ?? "",
            query: { ...filters, page: index + 1 },
          },
          signal,
        );
        if (value.resource !== "inboxList") throw new Error("No inbox.");
        return value.value;
      },
      enabled: ready && !!project,
      staleTime: 15_000,
      gcTime: 10 * 60_000,
      retry: false,
      meta: { daemonClient: client },
      ...(index === 0
        ? {
            placeholderData: keepPreviousData,
            refetchInterval: (query: { state: { data?: ForgeInboxList | undefined } }) =>
              (query.state.data?.pollSeconds ?? 60) * 1_000,
            refetchIntervalInBackground: false,
          }
        : {}),
    })),
  });
  const first = results[0];
  const failed = results.find((result) => result.isError);
  return {
    rows: visibleRows(
      results.map((result) => result.data),
      search,
    ),
    first: first?.data,
    stale: first?.isPlaceholderData ?? false,
    loading: !first?.data && !failed,
    error: failed?.error ?? undefined,
    more: results[results.length - 1]?.data?.nextPage !== undefined,
    retry: () => void Promise.all(results.map((result) => result.refetch())),
  };
}

const titles: Record<ForgeInboxWrite["action"], string> = {
  read: "Couldn't mark it read",
  done: "Couldn't mark it done",
  unsubscribe: "Couldn't unsubscribe",
  "read-all": "Couldn't mark everything read",
};

/**
 * Inbox writes through the person's own `gh`. The rows change at once; a refusal puts them back
 * by reading again. Every write sets a state, so one GitHub didn't confirm may be sent again,
 * but only when the person asks.
 */
export function useInboxWrites(project: string | undefined) {
  const client = useClient();
  const cache = useQueryClient();
  const toast = useToast();
  const ready = useConnectionState() === "ready";
  const change = (input: ForgeInboxWrite) =>
    cache.setQueriesData<ForgeInboxList>({ queryKey: inboxKey(project) }, (page) =>
      !page
        ? page
        : input.action === "read-all"
          ? afterWrite(page, {
              kind: "read-all",
              ...(input.repository
                ? {
                    repo: `${input.repository.host}/${input.repository.owner}/${input.repository.name}`,
                  }
                : {}),
            })
          : input.action === "unsubscribe"
            ? page
            : afterWrite(page, { kind: input.action, ids: new Set([input.id]) }),
    );
  const write = async (input: ForgeInboxWrite): Promise<boolean> => {
    if (!project || !ready) return false;
    change(input);
    try {
      await runCommand(client, {
        type: "forge.inbox.write",
        workspaceId: WorkspaceId.parse(project),
        input,
      });
      if (input.action !== "read") await cache.invalidateQueries({ queryKey: inboxKey(project) });
      return true;
    } catch (error) {
      const code =
        error instanceof CommandRefused ? error.code : (failureCode(error) ?? "command_failed");
      if (code === "action_outcome_uncertain") {
        const id = toast.error({
          title: "GitHub didn't confirm it",
          description: "It may have gone through. Sending it again is safe.",
          actionProps: {
            children: "Send again",
            onClick: () => {
              toast.close(id);
              void write(input);
            },
          },
        });
      } else toast.error({ title: titles[input.action], description: actionErrorText(code) });
      // Show what GitHub holds now, in place of the change that didn't land.
      await cache.invalidateQueries({ queryKey: inboxKey(project) });
      return false;
    }
  };
  /** Mark everything read up to now, in the filtered repository or everywhere. */
  const readAll = (repo: string | undefined, now: number) => {
    const repository = repositoryFromParam(repo);
    return write({
      action: "read-all",
      before: new Date(now).toISOString(),
      ...(repository ? { repository } : {}),
    });
  };
  return { ready: ready && !!project, write, readAll };
}
