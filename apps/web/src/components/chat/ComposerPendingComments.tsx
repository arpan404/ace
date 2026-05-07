import { ImageIcon, Trash2Icon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ComposerPendingCommentItem {
  readonly id: string;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly body: string;
  readonly previewUrl: string | null;
}

export function ComposerPendingComments(props: {
  readonly comments: ReadonlyArray<ComposerPendingCommentItem>;
  readonly className?: string;
  readonly onDismiss: (commentId: string) => void;
  readonly onClearAll: () => void;
}) {
  if (props.comments.length === 0) {
    return null;
  }

  return (
    <section
      className={cn(
        "mb-3 overflow-hidden rounded-[14px] border border-border/60 bg-card",
        props.className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground/70 uppercase">
            Pending comments
          </span>
          <span className="rounded-full border border-border/55 bg-background/85 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground/75">
            {props.comments.length}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 rounded-md border border-transparent px-2 text-[10px] font-medium text-muted-foreground/65 hover:border-destructive/20 hover:bg-destructive/10 hover:text-destructive"
                onClick={props.onClearAll}
                aria-label="Clear pending comments"
              />
            }
          >
            <Trash2Icon className="mr-1 size-3" />
            Clear
          </TooltipTrigger>
          <TooltipPopup side="top">Clear pending comments</TooltipPopup>
        </Tooltip>
      </div>
      <div className="max-h-[128px] overflow-y-auto">
        {props.comments.map((comment) => (
          <div
            key={comment.id}
            className="grid min-h-[44px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0"
          >
            <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-background/80 text-muted-foreground/70">
              {comment.previewUrl ? (
                <img
                  src={comment.previewUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <ImageIcon className="size-3.5" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-[11px] font-medium text-foreground/82">
                  {comment.sourceLabel}
                </span>
                <span className="min-w-0 truncate text-[11px] text-muted-foreground/62">
                  {comment.targetLabel}
                </span>
              </div>
              <p className="truncate text-[13px] font-medium text-foreground/88">{comment.body}</p>
            </div>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="size-7 rounded-md text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive"
              onClick={() => props.onDismiss(comment.id)}
              aria-label="Remove pending comment"
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
