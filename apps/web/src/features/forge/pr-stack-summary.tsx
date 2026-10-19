import type { ForgePrDetail, ForgeStackLayer } from "@ace/protocol";
import { cn } from "@/lib/cn.ts";
import { PrSection } from "./pr-section.tsx";
import { PrStackChip } from "./pr-stack-chip.tsx";
import { usePrStackQuery } from "./pr-stack-query.ts";
import { readFailureText } from "./query-state.tsx";

const stateWord = (layer: ForgeStackLayer) =>
  layer.state === "MERGED" ? "Merged" : layer.state === "CLOSED" ? "Closed" : "Open";

function LayerDot(props: { layer: ForgeStackLayer; current: boolean }) {
  const merged = props.layer.state === "MERGED";
  return (
    <span
      aria-hidden
      data-tone={props.current ? "done" : merged ? "waiting" : undefined}
      className={cn(
        "relative z-1 size-2 shrink-0 rounded-full",
        props.current || merged
          ? "bg-(--tone)"
          : "bg-panel shadow-[inset_0_0_0_1.5px_var(--color-faint-foreground)]",
      )}
    />
  );
}

/**
 * The stack this PR is a layer of: one dot per layer on a vertical rail, top layer first, the
 * current one in the foreground. A layer opens its own PR; the stack's actions sit behind the
 * section's chip.
 */
export function PrStackSummary(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  stack: { number: number; size: number; position: number };
  onRefresh(): void;
  onOpen(number: number): void;
}) {
  const ref = props.detail.status.ref;
  const query = usePrStackQuery({
    workspaceId: props.workspaceId,
    pr: ref,
    threadId: props.detail.relatedThreads[0]?.id ?? "",
  });
  const layers = (query.isError ? undefined : query.data?.stack?.layers)?.toSorted(
    (a, b) => b.position - a.position,
  );
  return (
    <PrSection
      title="Stack"
      count={props.stack.size}
      fixed
      action={
        <PrStackChip
          workspaceId={props.workspaceId}
          detail={props.detail}
          stack={props.stack}
          onRefresh={props.onRefresh}
          onOpen={props.onOpen}
        />
      }
    >
      {query.error ? (
        <p className="text-ui text-muted-foreground">{readFailureText(query.error)}</p>
      ) : layers?.length ? (
        <ol className="relative">
          <span aria-hidden className="absolute top-3 bottom-3 left-2.5 w-px bg-border" />
          {layers.map((layer) => {
            const current = layer.number === ref.number;
            return (
              <li key={layer.number}>
                <button
                  type="button"
                  aria-current={current ? "page" : undefined}
                  onClick={() => !current && props.onOpen(layer.number)}
                  className="flex min-h-7 w-full items-center gap-2.5 rounded-md px-1.5 text-left text-ui transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover"
                >
                  <LayerDot layer={layer} current={current} />
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      current ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <span className="tabular-nums">#{layer.number}</span> {layer.title}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-subtle-foreground">
                    {stateWord(layer)}
                  </span>
                </button>
              </li>
            );
          })}
          <li className="flex h-6 items-center gap-2.5 px-1.5 font-mono text-xs text-subtle-foreground">
            <span aria-hidden className="w-2 text-center">
              ↳
            </span>
            {query.data?.stack?.trunk}
          </li>
        </ol>
      ) : null}
    </PrSection>
  );
}
