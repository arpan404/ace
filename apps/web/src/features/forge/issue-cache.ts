import type { QueryClient } from "@tanstack/react-query";
import { ForgeIssueList, type ForgeIssueRow, type ForgeRepository } from "@ace/protocol";

/** Server search decides unknown membership; known state changes update visible rows now. */
export function refreshIssueLists(
  cache: QueryClient,
  workspaceId: string,
  repository: ForgeRepository,
  change?: { previous: ForgeIssueRow; next: ForgeIssueRow },
): void {
  const matches = (query: { queryKey: readonly unknown[]; state: { data: unknown } }) => {
    if (
      query.queryKey[0] !== "forge" ||
      query.queryKey[1] !== workspaceId ||
      query.queryKey[3] !== "issueList"
    )
      return false;
    const data = ForgeIssueList.safeParse(query.state.data);
    if (!data.success)
      return (
        query.queryKey[2] === undefined ||
        JSON.stringify(query.queryKey[2]) === JSON.stringify(repository)
      );
    return JSON.stringify(data.data.repository) === JSON.stringify(repository);
  };
  if (change && change.previous.state !== change.next.state) {
    for (const query of cache.getQueryCache().findAll({ predicate: matches })) {
      const parsed = ForgeIssueList.safeParse(query.state.data);
      if (
        !parsed.success ||
        !parsed.data.items.some((issue) => issue.ref.number === change.previous.ref.number)
      )
        continue;
      const list = parsed.data;
      const state = query.queryKey[4];
      const items = list.items.flatMap((issue) =>
        issue.ref.number !== change.previous.ref.number
          ? [issue]
          : state === change.next.state
            ? [change.next]
            : [],
      );
      cache.setQueryData(query.queryKey, {
        ...list,
        items,
        total: Math.max(0, list.total - (list.items.length - items.length)),
        counts: {
          ...list.counts,
          [change.previous.state]: Math.max(0, list.counts[change.previous.state] - 1),
          [change.next.state]: list.counts[change.next.state] + 1,
        },
      });
    }
  }
  void cache.invalidateQueries({ predicate: matches, refetchType: "all" });
}
