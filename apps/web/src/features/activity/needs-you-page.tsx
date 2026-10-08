import { useInteractions, useSidebarLoaded } from "@ace/client-react";
import { BellIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap, type KeymapId } from "@/lib/keymap.ts";
import { Page, PageTitle } from "@/features/shell/index.ts";
import { useActivityState } from "./activity-state.tsx";
import { EscalationCard } from "./escalation-card.tsx";
import { InteractionCard } from "./interaction-card.tsx";
import { LimitedThreads, useLimitedThreads } from "./limited-threads.tsx";
import { useNeedsYou } from "./use-needs-you.ts";

/**
 * Everything waiting on a person, as answerable cards, oldest first: approvals, questions and
 * plans from every thread (live from the daemon) and Deck decisions, then threads paused at a
 * usage limit. J/K (or ↓/↑) move focus between cards; the focused card takes A, D, 1–3, O, H
 * and X.
 */
export function NeedsYouPage() {
  const needs = useNeedsYou();
  const limited = useLimitedThreads();
  const loaded = useSidebarLoaded();
  const { focused, focusCard } = useActivityState();
  const empty = !needs.entries.length;
  const [watch, list] = useFocusFollowsCards();
  const move = (step: number) => {
    const root = list.current;
    const keys = cardKeys(root);
    const index = focused === undefined ? -1 : keys.indexOf(focused);
    const next = keys[Math.max(0, Math.min(keys.length - 1, index + step))];
    if (!next) return;
    focusCard(next);
    // DOM focus follows, so a screen reader announces the card's title.
    const card = root?.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(next)}"]`);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView?.({ block: "nearest" });
  };
  useHotkey(keymap["activity.next"].keys, () => move(1), { id: "activity.next" });
  useHotkey(keymap["activity.prev"].keys, () => move(-1), { id: "activity.prev" });
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
        title="You're all caught up"
        description="Approvals, questions and offset decisions from every thread land here, with mentions, CI failures and automation results."
      />
    );
  return (
    <Page>
      <PageTitle
        title="Needs you"
        lede="Approvals, questions and offset decisions from every thread, oldest first. Answer here, or open the thread for context."
      />
      <div ref={watch} className="mt-5 flex flex-col gap-3">
        {needs.entries.map((entry) =>
          entry.kind === "thread" ? (
            <ThreadCards key={entry.threadId} threadId={entry.threadId} />
          ) : (
            <EscalationCard key={entry.event.id} event={entry.event} />
          ),
        )}
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
  const { focused, focusCard } = useActivityState();
  const list = useRef<HTMLDivElement>(null);
  const previous = useRef<string[]>([]);
  const current = useRef(focused);
  useEffect(() => {
    current.current = focused;
  }, [focused]);
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
        const now = current.current;
        let next: string | undefined;
        if (now === undefined || now === automatic.current) {
          next = keys[0];
          automatic.current = next;
        } else if (keys.includes(now)) return;
        else next = keys[Math.max(0, Math.min(keys.length - 1, before.indexOf(now)))];
        current.current = next;
        focusCard(next);
        // An answered card held DOM focus, which fell to the page: hand it to the card that
        // took its place.
        const lost = document.activeElement === null || document.activeElement === document.body;
        if (lost && next && before.includes(now ?? ""))
          root
            .querySelector<HTMLElement>(`[data-card-key="${CSS.escape(next)}"]`)
            ?.focus({ preventScroll: true });
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(root, { childList: true, subtree: true });
      return () => {
        observer.disconnect();
        list.current = null;
      };
    },
    [focusCard],
  );
  return [watch, list] as const;
}

/** The card keys: shortcuts with an id follow their rebinding, the rest are fixed keys. */
const legend: { label: string; shortcut?: KeymapId; keys?: string }[] = [
  { label: "next", shortcut: "activity.next" },
  { label: "previous", shortcut: "activity.prev" },
  { label: "approve", shortcut: "activity.approve" },
  { label: "deny", shortcut: "activity.deny" },
  { label: "choose", keys: "1" },
  { label: "open thread", keys: "o" },
  { label: "snooze", keys: "h" },
  { label: "pick", keys: "x" },
];

function KeyLegend() {
  return (
    <p className="mt-[22px] flex flex-wrap gap-4 text-sm text-muted-foreground">
      {legend.map((entry) => (
        <span key={entry.label} className="inline-flex items-center gap-[5px]">
          {entry.shortcut ? (
            <Kbd shortcut={entry.shortcut} />
          ) : (
            <Kbd keys={entry.keys ?? ""} resolve={false} />
          )}
          {entry.label}
        </span>
      ))}
    </p>
  );
}
