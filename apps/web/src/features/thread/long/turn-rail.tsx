import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { ConversationRail } from "./conversation-rail.tsx";
import { useWatched, type ThreadNav } from "./nav.tsx";
import { useTurnHead, useTurnSummary } from "./turn-index.ts";
import { railOrdinals } from "./rail-ordinals.ts";

export function TurnRail({ nav }: { nav: ThreadNav }) {
  const head = useTurnHead(nav.threadId);
  const count = head?.count ?? 0;
  const current = useWatched(nav.currentTurn);
  const following = useWatched(nav.following);
  const reading = following ? count : (current ?? count);
  const markers = useMemo(
    () =>
      railOrdinals(count, reading).map((ordinal) => ({
        id: String(ordinal),
        label: `Turn ${ordinal}`,
        ordinal,
      })),
    [count, reading],
  );
  if (count < 2) return null;
  return (
    <div className="absolute top-20 bottom-24 left-0 z-[6] grid place-items-center">
      <ConversationRail
        className="max-h-full overflow-y-auto"
        markers={markers}
        currentId={String(reading)}
        onJump={(id) => {
          void nav.jump.toTurn(Number(id));
        }}
        renderPreview={(id) => <TurnPreview threadId={nav.threadId} ordinal={Number(id)} />}
      />
    </div>
  );
}

/** Only the open marker reads its cached index block; no transcript window is fetched. */
function TurnPreview({ threadId, ordinal }: { threadId: string; ordinal: number }) {
  const turn = useTurnSummary(threadId, ordinal);
  if (!turn)
    return (
      <div aria-label="Loading turn preview" className="space-y-2">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-3 w-40" />
      </div>
    );
  return (
    <div className="space-y-3 text-ui">
      <div>
        <p className="mb-1 text-2xs font-medium text-subtle-foreground">You</p>
        <p className="line-clamp-4 whitespace-pre-wrap break-words">
          {turn.initiatingMessagePreview || "No text in this prompt."}
        </p>
      </div>
      <div>
        <p className="mb-1 text-2xs font-medium text-subtle-foreground">Assistant</p>
        <p className="line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground">
          {turn.latestAgentMessagePreview || "No response yet."}
        </p>
      </div>
    </div>
  );
}
