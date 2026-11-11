import { useNavigate } from "@tanstack/react-router";
import type { ForgePrDetail } from "@ace/protocol";
import { formatSpan, prParticipants } from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useMachineSearch } from "@/lib/machine-routes.ts";
import { useNow } from "@/lib/time.ts";
import { cn } from "@/lib/cn.ts";
import type { PrActions } from "./pr-actions.ts";
import { useLinkedTasks } from "./pr-agent-chip.tsx";
import { presenceWords } from "./pr-presence.ts";
import { PrAvatar } from "./pr-presentation.tsx";
import { DetailRow } from "./pr-detail-row.tsx";

/**
 * The tasks working on this PR as cards: the provider's mark and the task's title, then its
 * state in its colour with how long, and what runs it. A card opens its thread.
 */
export function PrAgentBlock(props: { detail: ForgePrDetail }) {
  const navigate = useNavigate();
  const machine = useMachineSearch();
  const now = useNow();
  const { cards } = useLinkedTasks(props.detail);
  if (!cards.length) return null;
  const open = (threadId: string) =>
    void navigate({ to: "/t/$threadId", params: { threadId }, search: machine });
  return (
    <DetailRow label={cards.length === 1 ? "Agent" : `Agents · ${cards.length}`}>
      <ul className="flex flex-col gap-1.5 py-0.5">
        {cards.map((card) => {
          const since = card.status.since;
          const words = presenceWords(
            card.status,
            since !== undefined ? formatSpan(since, now) : undefined,
          );
          const quiet = card.status.tone === "idle" || card.status.tone === "done";
          return (
            <li key={card.id}>
              <button
                type="button"
                aria-label={`Open thread: ${card.title}`}
                onClick={() => open(card.id)}
                className="flex w-full min-w-0 flex-col gap-0.5 rounded-md border border-border bg-background px-3 py-2.5 text-left transition-colors duration-(--motion-fast) focus-ring hover:bg-hover"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderIcon
                    provider={card.provider}
                    acpAgentId={card.acpAgentId}
                    size={14}
                    decorative
                  />
                  <span className="min-w-0 truncate font-semibold text-foreground">
                    {card.title}
                  </span>
                </span>
                <span
                  key={words}
                  data-tone={quiet ? undefined : card.status.tone}
                  className={cn(
                    "fx-cross-in flex items-center gap-1.5 text-xs first-letter:uppercase",
                    quiet ? "text-muted-foreground" : "text-(--tone-text)",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      quiet ? "bg-faint-foreground" : "bg-(--tone)",
                    )}
                  />
                  <span className="first-letter:uppercase">{words}</span>
                </span>
                <span className="truncate text-xs text-subtle-foreground">
                  {card.providerLabel}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </DetailRow>
  );
}

/**
 * The head branch while the PR is open: its name, how many commits it carries and how it
 * stands against the base, and the checkout command a copy away.
 */
export function PrBranchBlock(props: { actions: PrActions }) {
  const { detail } = props.actions.context;
  const { status } = detail;
  const toast = useToast();
  const { copied, copy } = useCopy(() =>
    toast.error({ title: "Couldn't copy the checkout command" }),
  );
  if (status.state !== "open" && status.state !== "draft") return null;
  const repository = status.ref.repository;
  const checkout = `gh pr checkout ${status.ref.number} --repo ${repository.host}/${repository.owner}/${repository.name}`;
  const merge = props.actions.mergeState.state?.mergeState?.toUpperCase();
  const standing =
    merge === "BEHIND"
      ? `behind ${detail.baseBranch}`
      : merge && merge !== "UNKNOWN"
        ? `up to date with ${detail.baseBranch}`
        : undefined;
  const commits = `${detail.commits} ${detail.commits === 1 ? "commit" : "commits"}`;
  return (
    <DetailRow label="Branch">
      <span title={detail.headBranch} className="truncate font-mono text-xs text-foreground">
        {detail.headBranch}
      </span>
      <span className="text-xs text-subtle-foreground">
        {standing ? `${commits} · ${standing}` : commits}
      </span>
      <div className="mt-1.5 flex h-7 min-w-0 items-center gap-1 rounded-md border border-border bg-background pr-1 pl-2.5">
        <span
          title={checkout}
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
        >
          {`gh pr checkout ${status.ref.number}`}
        </span>
        <button
          type="button"
          aria-label={copied ? "Checkout command copied" : "Copy checkout command"}
          onClick={() => copy(checkout)}
          className="shrink-0 rounded-sm px-1.5 text-xs text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:text-foreground"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </DetailRow>
  );
}

/** Everyone in the conversation: the author, the reviewers and whoever commented. */
export function PrParticipantsBlock(props: { detail: ForgePrDetail }) {
  const people = prParticipants(props.detail);
  if (!people.length) return null;
  return (
    <DetailRow label={`${people.length} ${people.length === 1 ? "participant" : "participants"}`}>
      <ul aria-label="Participants" className="flex flex-wrap gap-1 py-1">
        {people.map((person) => (
          <li key={person.login} title={person.login}>
            <PrAvatar name={person.login} url={person.avatarUrl} />
          </li>
        ))}
      </ul>
    </DetailRow>
  );
}
