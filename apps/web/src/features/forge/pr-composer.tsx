import { useState } from "react";
import { ChatCircleIcon, PaperPlaneTiltIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover.tsx";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";

export function PrComposer(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
}) {
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<"comment" | "review">(
    props.extensions?.comment ? "comment" : "review",
  );
  const [pending, setPending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const selected =
    mode === "review" && !props.extensions?.review
      ? "comment"
      : mode === "comment" && !props.extensions?.comment
        ? "review"
        : mode;
  const action = selected === "review" ? props.extensions?.review : props.extensions?.comment;
  if (!props.extensions?.comment && !props.extensions?.review) return null;
  const disabled = props.context.disabled || pending || !body.trim();
  const send = async (close: boolean) => {
    const run = close ? props.extensions?.closeWithComment : action;
    if (disabled || !run) return;
    setPending(true);
    try {
      await run(body, props.context);
      setBody("");
      setOpen(false);
      setClosing(false);
      toast.add({
        title: close
          ? "Pull request closed with comment"
          : selected === "review"
            ? "Review submitted"
            : "Comment posted",
      });
    } catch (error) {
      toast.error({
        title: "Couldn't submit",
        description: error instanceof Error ? error.message : "Refresh GitHub before trying again.",
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="absolute right-5 bottom-4 z-10">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <IconButton
              icon={ChatCircleIcon}
              label="Write a comment or review"
              className="rounded-full bg-panel shadow-sm ring-1 ring-border"
            />
          }
        />
        <PopoverContent side="top" align="end" className="w-96 max-w-full space-y-4 p-4">
          <PopoverTitle className="sr-only">Comment on pull request</PopoverTitle>
          <div className="flex items-center justify-between">
            <Tabs
              value={selected}
              onValueChange={(value) => {
                if (value === "comment" || value === "review") {
                  setMode(value);
                  setClosing(false);
                }
              }}
            >
              <TabsList aria-label="Comment or review" className="rounded-card bg-muted p-0.5">
                {props.extensions?.comment && <TabsTab value="comment">Comment</TabsTab>}
                {props.extensions?.review && <TabsTab value="review">Review</TabsTab>}
              </TabsList>
            </Tabs>
            <PopoverClose render={<IconButton icon={XIcon} label="Close composer" />} />
          </div>
          <textarea
            autoFocus
            aria-label={selected === "review" ? "Review body" : "Comment body"}
            placeholder={selected === "review" ? "Leave a review" : "Leave a comment"}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setClosing(false);
            }}
            maxLength={65_536}
            className="min-h-24 w-full resize-y rounded-card border border-border bg-input p-3 text-base focus-ring"
          />
          {closing && (
            <p role="status" className="text-sm">
              Close this pull request and post the comment?
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {selected === "comment" && props.extensions?.closeWithComment && (
              <Button
                variant="danger"
                disabled={disabled}
                onClick={() => (closing ? void send(true) : setClosing(true))}
              >
                {closing ? "Confirm close with comment" : "Close with comment"}
              </Button>
            )}
            <Button disabled={disabled || !action} onClick={() => void send(false)}>
              <PaperPlaneTiltIcon aria-hidden size={14} />
              {selected === "review" ? "Submit review" : "Comment"}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
