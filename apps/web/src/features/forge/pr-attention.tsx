import { useMemo, type ReactNode } from "react";
import { XCircleIcon } from "@phosphor-icons/react";
import type { ForgeCheck, ForgePrDetail } from "@ace/protocol";
import { DisabledReason } from "@/components/ui/disabled-reason.tsx";
import { cn } from "@/lib/cn.ts";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import { attentionItems, type AttentionItem } from "./pr-summary-model.ts";
import { PrFixingWord } from "./pr-fixing-word.tsx";
import { useFixWithAgent } from "./pr-fix-with-agent.ts";
import { useCheckRerun, useCheckRun, useFetchCheckRun } from "./pr-check-run.ts";
import { checkControls, checkFixRequest, checkRunId, firstFailureLine } from "@ace/ui-core";
import { hiddenReasonOf } from "@ace/ui-core";
import { usePrReview } from "./pr-review-context.tsx";
import { PrReplyField, replyField } from "./pr-thread.tsx";
import { useAskFocus, useReplyOpen } from "./pr-ui-store.tsx";
import { useQuote } from "./pr-quote.tsx";
import { TextAction } from "./pr-text-action.tsx";

/** Who asked, by their avatar; a failing check by the failed status icon. */
function Lead(props: { item: AttentionItem; avatar: string | undefined }) {
  if (props.item.kind === "check")
    return (
      <span aria-hidden data-tone="failed" className="grid size-5 shrink-0 place-items-center">
        <XCircleIcon size={18} weight="fill" className="text-(--tone-text)" />
      </span>
    );
  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center">
      <PrAvatar name={props.item.author} url={props.avatar} />
    </span>
  );
}

/**
 * Opens a review comment's reply on its row and focuses it; pressed again, it focuses the open
 * field. The field's own Cancel closes it.
 */
function ReplyAction(props: { threadId: string; title: string }) {
  const field = replyField(props.threadId, "attention");
  const [open, setOpen] = useReplyOpen(field);
  const askFocus = useAskFocus();
  return (
    <TextAction
      aria-expanded={!!open}
      aria-label={`Reply: ${props.title}`}
      onClick={() => {
        setOpen(true);
        askFocus(`reply:${field}`);
      }}
    >
      Reply
    </TextAction>
  );
}

/** A row's words: who or what, what they did, where and when, then what they said. */
function Row(props: {
  item: AttentionItem;
  avatar: string | undefined;
  masked: boolean;
  /** What they said, or the check's first failure line; nothing when it said nothing. */
  quote: ReactNode;
  actions: ReactNode;
  after?: ReactNode;
}) {
  const { item } = props;
  return (
    <li className="flex items-start gap-2.5 px-4 py-3">
      <Lead item={item} avatar={props.avatar} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-ui">
          <span className="font-medium text-foreground">
            {item.kind === "check" ? item.title : item.author}
          </span>
          <span className="text-muted-foreground">
            {item.kind === "check" ? "failed" : item.kind === "review" ? "requested changes" : "on"}
          </span>
          {item.kind === "thread" && (
            <span
              title={item.detail}
              className="min-w-0 truncate font-mono text-xs text-foreground"
            >
              {item.detail.split("/").pop()}
            </span>
          )}
          {item.at && (
            <span className="text-xs text-subtle-foreground">
              <span aria-hidden>· </span>
              <PrTime at={item.at} />
            </span>
          )}
          <PrFixingWord subject={item.key} />
        </p>
        {props.quote !== undefined && (
          <div
            className={cn(
              "mt-0.5 line-clamp-3 text-ui break-words whitespace-pre-line",
              props.masked ? "text-subtle-foreground" : "text-foreground",
              item.kind === "check" && "font-mono text-xs",
            )}
          >
            {props.quote}
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 [&>button]:text-ui [&>button]:font-medium [&_button]:text-ui [&_button]:font-medium">
          {props.actions}
        </div>
        {props.after}
      </div>
    </li>
  );
}

/** A failing check's row: its first failure line, read from the run, with Open log and Re-run. */
function CheckRow(props: {
  item: AttentionItem & { kind: "check" };
  check: ForgeCheck;
  workspaceId: string;
  detail: ForgePrDetail;
  open: boolean;
  fix: ReactNode;
  disabled: boolean;
  onRefresh(): void | Promise<unknown>;
  onOpenCheck: ((id: string) => void) | undefined;
}) {
  const { check, detail } = props;
  const openCheck = props.onOpenCheck;
  const pr = detail.status.ref;
  const run = useCheckRun({ workspaceId: props.workspaceId, pr, check, enabled: true });
  const rerun = useCheckRerun({ workspaceId: props.workspaceId, pr, onDone: props.onRefresh });
  const line = run.data ? firstFailureLine(run.data) : undefined;
  const workflow = run.data?.workflow;
  const controls = checkControls(check, run.data, props.open);
  return (
    <Row
      item={props.item}
      avatar={undefined}
      masked={!line}
      quote={
        line ?? (checkRunId(check) !== undefined && run.isPending ? "Reading the log…" : undefined)
      }
      actions={
        <>
          {props.fix}
          {openCheck && <TextAction onClick={() => openCheck(check.id)}>Open log</TextAction>}
          {workflow && controls.rerunFailed && (
            <TextAction
              disabled={rerun.pending || props.disabled}
              onClick={() =>
                void rerun.run({
                  kind: "rerun",
                  runId: workflow.runId,
                  attempt: workflow.attempt,
                  jobs: "failed",
                })
              }
            >
              {rerun.pending ? "Re-running…" : "Re-run"}
            </TextAction>
          )}
        </>
      }
    />
  );
}

/**
 * What blocks the merge, each in its author's words: reviews asking for changes, open review
 * conversations and failing checks. Each has Fix with agent, and Reply · Show in code (a
 * conversation) or Open log · Re-run (a check). Nothing renders when nothing blocks.
 */
/** What blocks the merge, as the Summary's Blocking the merge lists it (hidden comments left out). */
export function useBlockingItems(detail: ForgePrDetail): AttentionItem[] {
  const state = usePrReview()?.state;
  return attentionItems(detail.status, (c) => hiddenReasonOf(state, c) !== undefined);
}

export function PrAttention(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  hostThreadId?: string | undefined;
  disabled: boolean;
  onRefresh?: (() => void | Promise<unknown>) | undefined;
  /** Opens the Code tab at a conversation's line; without it there is no Show in code. */
  onOpenCode?: ((path: string, line?: number) => void) | undefined;
  /** Opens a check's log in the Checks tab; without it there is no Open log. */
  onOpenCheck?: ((id: string) => void) | undefined;
}) {
  const { detail } = props;
  const onOpenCode = props.onOpenCode;
  const review = usePrReview();
  const state = review?.state;
  const quote = useQuote();
  // Hidden comments stay out of the list, and so out of any agent's request.
  const items = useBlockingItems(detail);
  const threads = useMemo(
    () => new Map(detail.status.reviewThreads.map((t) => [`thread:${t.id}`, t])),
    [detail.status.reviewThreads],
  );
  // Until GitHub's hidden state is known (while the review state loads, after each push, or
  // when it can't be read) a review comment might be hidden: its text stays out of the row and
  // out of any agent's request.
  const hiddenKnown = Array.isArray(state?.hidden);
  const unknownReason =
    state?.hidden === null
      ? "GitHub's hidden comments couldn't be read, so this comment may be hidden."
      : "Checking whether this comment is hidden on GitHub.";
  const agent = useFixWithAgent(props);
  const fetchRun = useFetchCheckRun(props.workspaceId, detail.status.ref);
  // A failing check's request carries its log excerpt and annotations, read as the panel would.
  const fix = async (item: AttentionItem) => {
    const check = detail.status.checks.find((candidate) => `check:${candidate.id}` === item.key);
    if (item.kind !== "check" || !check || checkRunId(check) === undefined) return agent.fix(item);
    const pr = { number: detail.status.ref.number, url: detail.status.url };
    const run = await fetchRun(check).catch(() => undefined);
    agent.ask(checkFixRequest(check, pr, run), item.key);
  };
  if (!items.length) return null;
  const open = detail.status.state === "open" || detail.status.state === "draft";
  const avatarOf = (author: string) =>
    detail.status.comments.find((c) => c.author === author && c.authorAvatarUrl)?.authorAvatarUrl;
  return (
    <section id="pr-attention" aria-label="Blocking the merge">
      <ul className="divide-y divide-border-soft">
        {items.map((item) => {
          const masked = item.kind !== "check" && !hiddenKnown;
          const title =
            item.kind === "check"
              ? item.title
              : masked
                ? item.kind === "thread"
                  ? `Review comment on ${item.detail}`
                  : `${item.author}'s review`
                : item.title || `${item.author}'s review`;
          const fixAction = open && (
            <DisabledReason reason={masked ? unknownReason : undefined}>
              <TextAction
                strong
                disabled={props.disabled || masked}
                aria-label={`Fix with agent: ${title}`}
                onClick={() => void fix(item)}
              >
                Fix with agent
              </TextAction>
            </DisabledReason>
          );
          if (item.kind === "check") {
            const check = detail.status.checks.find((c) => `check:${c.id}` === item.key);
            if (!check) return null;
            return (
              <CheckRow
                key={item.key}
                item={item}
                check={check}
                workspaceId={props.workspaceId}
                detail={detail}
                open={open}
                fix={fixAction}
                disabled={props.disabled}
                onRefresh={props.onRefresh ?? (() => {})}
                onOpenCheck={props.onOpenCheck}
              />
            );
          }
          const thread = item.kind === "thread" ? threads.get(item.key) : undefined;
          const root = thread?.comments[0];
          const words = masked ? "Review comment" : item.body || "Requested changes";
          return (
            <Row
              key={item.key}
              item={item}
              avatar={root?.authorAvatarUrl ?? avatarOf(item.author)}
              masked={masked}
              quote={words}
              actions={
                <>
                  {fixAction}
                  {thread && root && <ReplyAction threadId={thread.id} title={title} />}
                  {item.kind === "review" && !masked && quote && (
                    <TextAction
                      aria-label={`Reply: ${title}`}
                      onClick={() => quote("conversation", item.body)}
                    >
                      Reply
                    </TextAction>
                  )}
                  {item.kind === "thread" && onOpenCode && (
                    <TextAction
                      aria-label={`Show in code: ${item.detail}`}
                      onClick={() => onOpenCode(item.file, item.line ?? undefined)}
                    >
                      Show in code
                    </TextAction>
                  )}
                </>
              }
              after={
                thread &&
                root && (
                  <PrReplyField
                    threadId={thread.id}
                    rootCommentId={root.id}
                    place="attention"
                    className="mt-2"
                  />
                )
              }
            />
          );
        })}
      </ul>
    </section>
  );
}
