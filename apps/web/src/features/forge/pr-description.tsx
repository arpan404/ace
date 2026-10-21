import { useLayoutEffect, useRef, useState } from "react";
import { PencilSimpleIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { PrMarkdown } from "./pr-markdown.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrSection } from "./pr-section.tsx";
import { PrReactionPicker, PrReactions } from "./pr-reactions.tsx";

/**
 * The PR's description as markdown, clamped to four whole lines with Show more when it runs
 * longer. The clamp counts rendered lines, so it never leaves half a line showing.
 */
export function PrDescription(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  onOpen(number: number): void;
  onEdit: (() => void) | undefined;
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
  return (
    <PrSection
      title="Description"
      fixed
      action={
        <>
          <PrReactionPicker subject={{ kind: "pr" }} />
          {edit && (
            <IconButton
              icon={PencilSimpleIcon}
              label="Edit description"
              size="sm"
              disabled={props.context.disabled}
              onClick={edit}
            />
          )}
        </>
      }
    >
      {body.trim() ? (
        <div>
          <div
            ref={box}
            className={cn(
              !expanded &&
                "line-clamp-4 [&_*]:my-0 [&_h1,&_h2,&_h3,&_h4]:text-ui [&_h1,&_h2,&_h3,&_h4]:font-medium",
            )}
          >
            <PrMarkdown
              context={props.context}
              extensions={props.extensions}
              onOpen={props.onOpen}
              text={body}
            />
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
        <p className="text-ui text-muted-foreground italic">No description provided.</p>
      )}
      <PrReactions subject={{ kind: "pr" }} className="mt-1.5" onlyWhenAny />
    </PrSection>
  );
}
