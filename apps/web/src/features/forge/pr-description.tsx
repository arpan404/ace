import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { PrMarkdown } from "./pr-markdown.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import { SectionAction, SummarySection, summaryCard } from "./pr-summary-section.tsx";
import { PrReactionPicker, PrReactions } from "./pr-reactions.tsx";

/**
 * The PR's description: who opened it and when, a reaction and Edit beside the heading, and the
 * markdown on a card, capped with Show more when it runs long.
 */
export function PrDescription(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  onOpen(number: number): void;
  onEdit: (() => void) | undefined;
  /** Saves the description with one task box ticked, when the viewer may edit it. */
  onTasks?: ((body: string) => Promise<boolean>) | undefined;
}) {
  const body = props.context.detail.body;
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [expanded]);
  const edit = props.extensions?.editDescription
    ? () => props.extensions?.editDescription?.(props.context)
    : props.onEdit;
  const { detail } = props.context;
  const at = detail.createdAt ?? detail.updatedAt;
  return (
    <SummarySection
      title="Description"
      right={
        <>
          <span className="mr-1 inline-flex min-w-0 items-center gap-1.5 text-ui">
            <PrAvatar name={detail.author} url={detail.authorAvatarUrl} />
            <span className="truncate">{detail.author}</span>
            {at && (
              <span className="shrink-0 text-subtle-foreground">
                <span aria-hidden>· </span>
                <PrTime at={at} />
              </span>
            )}
          </span>
          <PrReactionPicker subject={{ kind: "pr" }} />
          {edit && (
            <SectionAction disabled={props.context.disabled} onClick={edit}>
              Edit
            </SectionAction>
          )}
        </>
      }
    >
      <div className={cn(summaryCard, "px-4 pt-3 pb-3.5")}>
        {body.trim() ? (
          <div>
            <div
              ref={box}
              className={cn(
                "relative",
                // Images and other blocks run long: the cap keeps a long description a preview.
                !expanded && "max-h-96 overflow-hidden",
              )}
            >
              <PrMarkdown
                context={props.context}
                extensions={props.extensions}
                onOpen={props.onOpen}
                tasks={props.onTasks}
                text={body}
              />
              {overflows && !expanded && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-b from-transparent to-background"
                />
              )}
            </div>
            {(overflows || expanded) && (
              <Button
                variant="ghost"
                size="xs"
                className="-ml-1.5 mt-1"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "Show less" : "Show more"}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-ui text-subtle-foreground">No description.</p>
        )}
        <PrReactions subject={{ kind: "pr" }} className="mt-2.5" onlyWhenAny />
      </div>
    </SummarySection>
  );
}
