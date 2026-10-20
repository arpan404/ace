import { ChatTextIcon } from "@phosphor-icons/react";
import { useClient } from "@ace/client-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { hitSeq } from "@/features/search/index.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { searchSettleMs, useDebouncedValue } from "@/lib/debounced.ts";
import { focusComposerSoon } from "@/lib/focus-composer.ts";
import { useProjectName } from "@/lib/projects.ts";
import { messageMinLength, readQuery } from "./arrange.ts";
import type { PaletteCommand } from "./types.ts";

/** Messages a query lists in the palette; full search has the rest. */
const shown = 8;

/**
 * Messages inside threads that match the query (from two characters, not for `>` queries),
 * from the daemon's full-text index: each opens its thread at the message.
 */
export function useMessageHits(query: string, close: () => void): PaletteCommand[] {
  const { text, actionsOnly } = readQuery(query);
  const settled = useDebouncedValue(text, searchSettleMs);
  const navigate = useNavigate();
  const router = useRouter();
  const client = useClient();
  const projectName = useProjectName();
  const enabled = !actionsOnly && settled.length >= messageMinLength;
  const found = useDaemonQuery({
    queryKey: ["palette-messages", settled],
    enabled,
    read: async (api, signal) => {
      const reply = await api.request(
        { type: "search.query", text: settled, limit: shown, filters: { kinds: ["message"] } },
        { signal },
      );
      return reply.type === "search.results" ? reply.hits : [];
    },
  });
  const hits = enabled && text === settled ? found.data : undefined;
  return useMemo(
    () =>
      (hits ?? []).map((hit): PaletteCommand => {
        const open = async () => {
          close();
          const target = {
            to: "/t/$threadId" as const,
            params: { threadId: hit.threadId },
            search: { q: settled },
          };
          await navigate(target);
          const location = router.state.location;
          focusComposerSoon();
          const seq = await hitSeq(client, { threadId: hit.threadId, itemId: hit.itemId }, settled);
          if (seq !== undefined && router.state.location === location)
            void navigate({ ...target, search: { q: settled, seq }, replace: true });
        };
        return {
          id: `message-${hit.itemId ?? hit.threadId}`,
          label: hit.threadTitle,
          detail: projectName(hit.workspaceId),
          kind: "message",
          threadId: hit.threadId,
          icon: ChatTextIcon,
          snippet: hit.snippet,
          run: () => void open(),
        };
      }),
    [hits, settled, close, navigate, router, client, projectName],
  );
}
