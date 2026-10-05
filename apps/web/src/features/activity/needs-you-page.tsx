import { useInteractions, useSidebarLoaded } from "@ace/client-react";
import { BellIcon } from "@phosphor-icons/react";
import { useCallback, useRef } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { Page, PageTitle } from "@/features/shell/index.ts";
import { useActivityState } from "./activity-state.tsx";
import { EscalationCard } from "./escalation-card.tsx";
import { InteractionCard } from "./interaction-card.tsx";
import { LimitedThreads, useLimitedThreads } from "./limited-threads.tsx";
import { useNeedsYou } from "./use-needs-you.ts";

/**
 * Everything waiting on a person, as answerable cards: approvals, questions and plans from
 * every thread (live from the daemon), then Deck escalations, then threads paused at a usage
 * limit. J/K move between cards; the
 * focused card takes A, D, 1–3 and O.
 */
export function NeedsYouPage() {
  const needs = useNeedsYou();
  const limited = useLimitedThreads();
  const loaded = useSidebarLoaded();
  const { setFocused } = useActivityState();
  const empty = !needs.threadIds.length && !needs.escalations.length;
  const [watch, list] = useFocusFollowsCards();
  const move = (step: number) => {
    const keys = cardKeys(list.current);
    setFocused((current) => {
      const index = current === undefined ? -1 : keys.indexOf(current);
      return keys[Math.max(0, Math.min(keys.length - 1, index + step))] ?? current;
    });
  };
  useHotkey("j", () => move(1));
  useHotkey("k", () => move(-1));
  // Never say "nothing needs you" before the thread list has arrived.
  if (!loaded)
    return (
      <Page>
        <PageTitle title="Needs you" />
        <ListSkeleton label="requests" shape="card" rows={3} className="mt-5" />
      </Page>
    );
  if (empty && !limited.length)
    return (
      <EmptyState
        icon={BellIcon}
        title="Nothing needs you"
        description="Approvals, questions and escalations from every thread land here."
      />
    );
  return (
    <Page>
      <PageTitle
        title="Needs you"
        lede="Approvals, questions and escalations from every thread. Answer here, or open the thread for context."
      />
      <div ref={watch} className="mt-5 flex flex-col gap-3">
        {needs.threadIds.map((id) => (
          <ThreadCards key={id} threadId={id} />
        ))}
        {needs.escalations.map((event) => (
          <EscalationCard key={event.id} event={event} />
        ))}
      </div>
      {!empty && <KeyLegend />}
      <LimitedThreads threads={limited} />
    </Page>
  );
}

function ThreadCards(props: { threadId: string }) {
  const open = useInteractions(props.threadId);
  return (open ?? []).map((id) => (
    <InteractionCard key={id} threadId={props.threadId} interactionId={id} />
  ));
}

function cardKeys(root: HTMLElement | null): string[] {
  return [...(root?.querySelectorAll<HTMLElement>("[data-card-key]") ?? [])].flatMap((element) =>
    element.dataset.cardKey ? [element.dataset.cardKey] : [],
  );
}

/**
 * Keep a card focused as cards arrive and leave. Cards mount on their own as each thread's
 * store loads, so the list is watched rather than derived. When the focused card is answered,
 * focus moves to the card that took its place.
 */
function useFocusFollowsCards() {
  const { setFocused } = useActivityState();
  const list = useRef<HTMLDivElement>(null);
  const previous = useRef<string[]>([]);
  // The first card is focused by default until the person moves; cards that load later and
  // sort above it take the default over.
  const automatic = useRef<string>(undefined);
  const watch = useCallback(
    (root: HTMLDivElement | null) => {
      list.current = root;
      if (!root) return;
      const sync = () => {
        const keys = cardKeys(root);
        const before = previous.current;
        previous.current = keys;
        setFocused((current) => {
          if (current === undefined || current === automatic.current) {
            automatic.current = keys[0];
            return keys[0];
          }
          if (keys.includes(current)) return current;
          const gone = before.indexOf(current);
          return keys[Math.max(0, Math.min(keys.length - 1, gone))];
        });
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(root, { childList: true, subtree: true });
      return () => {
        observer.disconnect();
        list.current = null;
      };
    },
    [setFocused],
  );
  return [watch, list] as const;
}

function KeyLegend() {
  const entries: [string[], string][] = [
    [["J", "K"], "move"],
    [["A"], "approve"],
    [["D"], "deny"],
    [["1", "2", "3"], "choose"],
    [["O"], "open thread"],
  ];
  return (
    <p className="mt-[22px] flex flex-wrap gap-4 text-[12px] text-subtle-foreground">
      {entries.map(([keys, label]) => (
        <span key={label} className="inline-flex items-center gap-[5px]">
          {keys.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
          {label}
        </span>
      ))}
    </p>
  );
}
