import type { SpadeProposal, SpadeView } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { answerProposal, readProposals } from "./spade-workspace-api.ts";

/**
 * A bot's skill proposals (ADR 0130), read again whenever a `skill_propose` call the list
 * doesn't hold yet finishes in the conversation, so a new proposal shows as its reply ends.
 */
export function useSkillProposals(bot: string, view: SpadeView) {
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  const cache = useQueryClient();
  const key = useMemo(() => ["spade", "proposals", machine.key, bot] as const, [machine.key, bot]);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readProposals(client, bot, { signal }),
  });
  const proposed = view.entries.flatMap((entry) =>
    entry.kind === "reply"
      ? entry.parts.flatMap((part) =>
          part.kind === "call" && part.name === "skill_propose" && part.state === "done"
            ? [part.key]
            : [],
        )
      : [],
  );
  const asked = useRef(new Set<string>());
  const { data, isFetching, refetch } = query;
  const missingKey = data
    ? proposed.filter((call) => !data.some((p) => p.callId === call)).join(",")
    : "";
  useEffect(() => {
    if (!missingKey || isFetching) return;
    // Each call is asked about once: a proposal that was replaced never comes back.
    const fresh = missingKey.split(",").filter((call) => !asked.current.has(call));
    if (!fresh.length) return;
    for (const call of fresh) asked.current.add(call);
    void refetch();
  }, [missingKey, isFetching, refetch]);

  return {
    proposals: data ?? [],
    async answer(id: string, save: boolean): Promise<SpadeProposal> {
      const answered = await answerProposal(client, bot, id, save);
      cache.setQueryData<SpadeProposal[]>(key, (list) =>
        list?.map((proposal) => (proposal.id === id ? answered : proposal)),
      );
      return answered;
    },
  };
}
