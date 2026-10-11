import type { ClientApi } from "@ace/client";
import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { subscribeSettings } from "./settings-subscription.ts";

/** Drop account-dependent data and cancel old reads before asking the affected daemon again. */
export async function refreshSourceControl(queries: QueryClient, client: ClientApi): Promise<void> {
  const predicate = (query: Query) => {
    const [owner, resource] = query.queryKey;
    return (
      query.meta?.daemonClient === client &&
      ((owner === "thread" && (resource === "pr" || resource === "details")) ||
        (owner === "projects" &&
          (resource === "github-readiness" || resource === "github-repositories")))
    );
  };
  await queries.cancelQueries({ predicate });
  await queries.resetQueries({ predicate });
}

/** Settings pushes and reconnects invalidate PR reads even if Settings is closed. */
export function useSourceControlCache(client: ClientApi): void {
  const queries = useQueryClient();
  useEffect(() => {
    const subscription = subscribeSettings(
      client,
      ["sourceControl.preferences"],
      {},
      () => {
        void refreshSourceControl(queries, client);
      },
      () => {
        void refreshSourceControl(queries, client);
      },
    );
    return () => subscription.stop();
  }, [client, queries]);
}
