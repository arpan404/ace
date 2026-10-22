import { useState } from "react";
import { ArrowsDownUpIcon, FunnelIcon } from "@phosphor-icons/react";
import type { ForgeComment, ForgePrStatus } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Menu, MenuCheckboxItem, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";
import { PrComment } from "./pr-comment.tsx";
import { PrSection } from "./pr-section.tsx";
import { PrThread } from "./pr-thread.tsx";
import { conversation, reviewOutcomeLabels, type ReviewOutcome } from "./pr-summary-model.ts";

const page = 10;
const verdicts: Record<string, ReviewOutcome> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  DISMISSED: "dismissed",
};
const verdictTone: Record<ReviewOutcome, string> = {
  approved: "text-status-done",
  changes: "text-status-failed",
  commented: "text-muted-foreground",
  dismissed: "text-subtle-foreground",
};

function CommentRow(props: { comment: ForgeComment; open: boolean; onToggle(): void }) {
  const { comment } = props;
  const verdict = verdicts[comment.reviewState?.toUpperCase() ?? ""];
  return (
    <li className="py-3">
      <PrComment
        comment={comment}
        words={
          verdict && (
            <span className={cn("font-medium", verdictTone[verdict])}>
              {reviewOutcomeLabels[verdict]}
            </span>
          )
        }
        place={
          comment.kind === "inline" && comment.file
            ? `${comment.file}:${comment.line ?? ""}`
            : undefined
        }
        quoteTarget="conversation"
        outdated={comment.line === null}
        open={props.open}
        onToggle={props.onToggle}
      />
    </li>
  );
}

/**
 * The PR's conversation as rows, newest first by default, ten at a time. Bot comments and
 * resolved threads can be filtered out; resolved threads start folded to one line.
 */
export function PrComments(props: { status: ForgePrStatus }) {
  const [order, setOrder] = useState<"newest" | "oldest">("newest");
  const [bots, setBots] = useState(true);
  const [resolved, setResolved] = useState(true);
  const [limit, setLimit] = useState(page);
  // Which long comments are open, kept here so rows can remount without folding again.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const view = conversation(props.status, { bots, resolved, order, limit });
  const older = view.older > 0 && (
    <Button size="sm" onClick={() => setLimit(limit + page)}>
      {`Show ${Math.min(page, view.older)} older (${view.older} hidden)`}
    </Button>
  );
  // No conversation yet: nothing to show; the Timeline's comment box starts one.
  if (view.total === 0) return null;
  return (
    <PrSection
      title="Comments"
      count={view.total}
      action={
        view.total > 0 && (
          <>
            <Menu>
              <MenuTrigger render={<Button variant="ghost" size="xs" />}>
                <FunnelIcon aria-hidden size={14} />
                {view.filtered ? `${view.filtered} hidden` : "Filter"}
              </MenuTrigger>
              <MenuContent align="end">
                <MenuCheckboxItem checked={bots} onCheckedChange={setBots}>
                  Bot comments
                </MenuCheckboxItem>
                <MenuCheckboxItem checked={resolved} onCheckedChange={setResolved}>
                  Resolved and dismissed
                </MenuCheckboxItem>
              </MenuContent>
            </Menu>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setOrder(order === "newest" ? "oldest" : "newest")}
            >
              <ArrowsDownUpIcon aria-hidden size={14} />
              {order === "newest" ? "Newest first" : "Oldest first"}
            </Button>
          </>
        )
      }
    >
      {view.items.length ? (
        <div className="space-y-2">
          {order === "oldest" && older}
          <ol className="divide-y divide-border-soft">
            {view.items.map((item) =>
              item.kind === "comment" ? (
                <CommentRow
                  key={item.key}
                  comment={item.comment}
                  open={expanded.has(item.key)}
                  onToggle={() => toggle(item.key)}
                />
              ) : (
                <li key={item.key} className="py-3">
                  <PrThread thread={item.thread} place />
                </li>
              ),
            )}
          </ol>
          {order === "newest" && older}
          {limit > page && (
            <Button variant="ghost" size="sm" onClick={() => setLimit(page)}>
              {`Show only ${page} recent`}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-ui text-muted-foreground">
          {view.total ? "Every comment is filtered out." : "No comments yet."}
        </p>
      )}
    </PrSection>
  );
}
