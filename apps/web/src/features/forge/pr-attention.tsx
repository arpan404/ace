import { SparkleIcon } from "@phosphor-icons/react";
import type { ForgePrDetail } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { rowCard } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import { PrSection } from "./pr-section.tsx";
import { attentionItems, type AttentionItem } from "./pr-summary-model.ts";
import { useFixWithAgent } from "./pr-fix-with-agent.ts";
import { useFetchCheckRun } from "./pr-check-run.ts";
import { checkFixRequest, checkRunId } from "./pr-check-model.ts";

function Lead(props: { item: AttentionItem; avatar: string | undefined }) {
  if (props.item.kind === "check")
    return (
      <span
        aria-hidden
        data-tone="failed"
        className="mt-1.5 size-1.5 shrink-0 rounded-full bg-(--tone)"
      />
    );
  return (
    <span className="mt-0.5 inline-flex shrink-0 rounded-full ring-2 ring-status-failed ring-offset-1 ring-offset-panel">
      <PrAvatar name={props.item.author} url={props.avatar} />
    </span>
  );
}

/**
 * What stands in the way and an agent could fix: failing checks and open review threads, each
 * with "Fix with agent". Nothing renders when there is nothing to fix.
 */
export function PrAttention(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  hostThreadId?: string | undefined;
  disabled: boolean;
}) {
  const { detail } = props;
  const items = attentionItems(detail.status);
  const agent = useFixWithAgent(props);
  const fetchRun = useFetchCheckRun(props.workspaceId, detail.status.ref);
  // A failing check's request carries its log excerpt and annotations, read as the panel would.
  const fix = async (item: AttentionItem) => {
    const check = detail.status.checks.find((candidate) => `check:${candidate.id}` === item.key);
    if (item.kind !== "check" || !check || checkRunId(check) === undefined) return agent.fix(item);
    const pr = { number: detail.status.ref.number, url: detail.status.url };
    const run = await fetchRun(check).catch(() => undefined);
    agent.ask(checkFixRequest(check, pr, run));
  };
  if (!items.length) return null;
  const open = detail.status.state === "open" || detail.status.state === "draft";
  return (
    <PrSection id="pr-attention" title="Needs attention" count={items.length} fixed>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.key} className={cn(rowCard, "flex items-start gap-2.5 px-3 py-2")}>
            <Lead
              item={item}
              avatar={
                item.kind === "thread"
                  ? detail.status.comments.find((c) => c.author === item.author)?.authorAvatarUrl
                  : undefined
              }
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui text-foreground">{item.title}</p>
              <p className="flex min-w-0 items-center gap-1.5 text-xs text-subtle-foreground">
                <span className={cn("truncate", item.kind === "thread" && "font-mono")}>
                  {item.kind === "check" ? "Check failed" : item.detail}
                </span>
                {item.at && (
                  <>
                    <span aria-hidden>·</span>
                    <PrTime at={item.at} />
                  </>
                )}
              </p>
            </div>
            {open && (
              <Button
                size="xs"
                variant="secondary"
                className="shrink-0"
                disabled={props.disabled}
                aria-label={`Fix with agent: ${item.title}`}
                onClick={() => void fix(item)}
              >
                <SparkleIcon aria-hidden size={12} />
                <span className="@max-[30rem]/pr:sr-only">Fix with agent</span>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </PrSection>
  );
}
