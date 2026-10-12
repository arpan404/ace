import type { ForgePrRef, ForgeRepository } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Button } from "@/components/ui/button.tsx";
import { readForge } from "./source.ts";

export function useStackMemberships(
  workspaceId: string,
  repository: ForgeRepository,
  numbers: number[],
) {
  const query = useDaemonQuery({
    queryKey: ["forge", workspaceId, repository, "stack-memberships", numbers],
    enabled: numbers.length > 0,
    retry: false,
    staleTime: 0,
    refetchOnReconnect: "always",
    refetchInterval: 30_000,
    read: async (client, signal) => {
      const result = await readForge(
        client,
        { op: "forge.pr.stack-memberships", workspaceId, repository, numbers },
        signal,
      );
      if (result.resource !== "prStackMemberships")
        throw new Error("No stack membership returned.");
      return result.value;
    },
  });
  return {
    ...query,
    mergeBlocker:
      !query.data || query.isError || !!query.data[0]?.stack
        ? "Open the full PR workspace to inspect native stack merge rules."
        : undefined,
  };
}
function RepositoryStackGroups(props: {
  workspaceId: string;
  repository: ForgeRepository;
  numbers: number[];
  onOpen(ref: ForgePrRef): void;
}) {
  const query = useStackMemberships(props.workspaceId, props.repository, props.numbers);
  const groups = new Map<
    string,
    { number: number; trunk: string; size: number; layers: { number: number; position: number }[] }
  >();
  for (const row of query.data ?? []) {
    if (!row.stack) continue;
    const group = groups.get(row.stack.id) ?? {
      number: row.stack.number,
      trunk: row.stack.trunk,
      size: row.stack.size,
      layers: [],
    };
    group.layers.push({ number: row.number, position: row.stack.position });
    groups.set(row.stack.id, group);
  }
  return (
    <>
      {!query.isError &&
        [...groups.entries()].map(([id, stack]) => (
          <div key={id} className="space-y-2 border-l border-border pl-3 text-sm">
            <p>
              {props.repository.owner}/{props.repository.name}
            </p>
            <p>
              Native stack #{stack.number} → {stack.trunk} · {stack.size} layers
            </p>
            <div className="flex flex-wrap gap-2">
              {stack.layers
                .toSorted((a, b) => a.position - b.position)
                .map((layer) => (
                  <Button
                    key={layer.number}
                    onClick={() =>
                      props.onOpen({ repository: props.repository, number: layer.number })
                    }
                  >
                    #{layer.number} · layer {layer.position}
                  </Button>
                ))}
            </div>
          </div>
        ))}
    </>
  );
}
/** Groups only host-confirmed members. It never links other layers to a task. */
export function PrStackGroups(props: {
  workspaceId: string;
  refs: ForgePrRef[];
  onOpen(ref: ForgePrRef): void;
}) {
  const repositories = new Map<string, { repository: ForgeRepository; numbers: number[] }>();
  for (const ref of props.refs.slice(0, 100)) {
    const key = JSON.stringify(ref.repository);
    const group = repositories.get(key) ?? { repository: ref.repository, numbers: [] };
    if (!group.numbers.includes(ref.number)) group.numbers.push(ref.number);
    repositories.set(key, group);
  }
  return (
    <section aria-label="Native pull request stacks" className="space-y-3">
      {[...repositories.entries()].map(([key, group]) => (
        <RepositoryStackGroups
          key={key}
          workspaceId={props.workspaceId}
          repository={group.repository}
          numbers={group.numbers}
          onOpen={props.onOpen}
        />
      ))}
    </section>
  );
}
