import { useLayoutEffect, useRef, useState } from "react";
import { PencilSimpleIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { PrMarkdown } from "./pr-markdown.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import { PrReactionPicker, PrReactions } from "./pr-reactions.tsx";

/**
 * The PR's description as the first message of its conversation: who opened it and when, with
 * reactions and Edit, and the markdown under it, capped with Show more when it runs long.
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
    <section aria-label="Description">
      <div className="flex h-8 items-center gap-2 text-ui">
        <PrAvatar name={detail.author} url={detail.authorAvatarUrl} />
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
          <span className="truncate font-medium text-foreground">{detail.author}</span>
          <span className="shrink-0 text-muted-foreground">
            {at ? (
              <PrTime at={at} prefix={detail.createdAt ? "opened " : "updated "} />
            ) : (
              "opened this pull request"
            )}
          </span>
        </p>
        <div className="-mr-1 flex shrink-0 items-center gap-0.5">
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
        </div>
      </div>
      <div className="pt-1.5 pl-7">
        {body.trim() ? (
          <div>
            <div
              ref={box}
              className={cn(
                "relative",
                // Images and other blocks run long: the cap keeps a long description a preview.
                !expanded && "max-h-80 overflow-hidden",
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
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-b from-transparent to-panel"
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
          <p className="text-ui text-muted-foreground italic">No description provided.</p>
        )}
        <PrReactions subject={{ kind: "pr" }} className="mt-2" onlyWhenAny />
      </div>
    </section>
  );
}
