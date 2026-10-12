import { useState } from "react";
import type { ForgePrRef } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Button } from "@/components/ui/button.tsx";
import { QueryState } from "./query-state.tsx";
import { readForge } from "./source.ts";
export function PrActivity(props: { workspaceId: string; pr: ForgePrRef }) {
  const [page, setPage] = useState(1);
  const query = useDaemonQuery({
    queryKey: ["forge", props.workspaceId, props.pr, "activity", page],
    retry: false,
    read: async (client, signal) => {
      const result = await readForge(
        client,
        {
          op: "forge.pr.activity",
          workspaceId: props.workspaceId,
          repository: props.pr.repository,
          number: props.pr.number,
          page,
        },
        signal,
      );
      if (result.resource !== "prActivity") throw new Error("No activity response.");
      return result;
    },
  });
  return (
    <section aria-label="GitHub activity" className="space-y-3">
      <h3 className="text-base font-medium">GitHub activity</h3>
      <QueryState query={query} />
      {query.data && (
        <>
          <ol>
            {query.data.events.map((event) => (
              <li key={event.id} className="py-2 text-sm">
                {event.actor} · {event.event.replaceAll("_", " ")} · {event.at ?? "Date unknown"}
              </li>
            ))}
          </ol>
          {query.data.truncated && <p role="status">Activity is truncated.</p>}
          <div className="flex gap-2">
            <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous activity
            </Button>
            <Button
              disabled={!query.data.nextPage}
              onClick={() => query.data?.nextPage && setPage(query.data.nextPage)}
            >
              Next activity
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
