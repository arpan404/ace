import { useState } from "react";
import { ChatCircleIcon, PaperPlaneTiltIcon, XIcon } from "@phosphor-icons/react";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { draftKeys, useMarkdownDraft } from "@/components/markdown-editor/use-markdown-draft.ts";
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
import { usePrReview } from "./pr-review-context.tsx";
import { PrConversationComposer, PrReviewSubmission } from "./pr-review-forms.tsx";

/**
 * Room every PR tab body leaves under its last row for the floating comment button (30px,
 * 12px off the bottom) and a gap, so scrolled to the end nothing sits under it.
 */
export const composerClearance = "pb-16";

export function PrComposer(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
}) {
  const draft = useMarkdownDraft(
    draftKeys.prComment(props.context.workspaceId, JSON.stringify(props.context.detail.status.ref)),
  );
  const body = draft.text;
  const [mode, setMode] = useState<"comment" | "review">(
    props.extensions?.comment ? "comment" : "review",
  );
  const [pending, setPending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const hosted = usePrReview();
  const hostedOnly = !props.extensions?.comment && !props.extensions?.review;
  const native = hostedOnly && hosted?.state?.canComment;
  // The host's own review: a verdict plus the line drafts saved from the Code tab.
  const nativeReview =
    hostedOnly &&
    !!hosted?.state &&
    (hosted.state.canReview || hosted.state.canComment || hosted.state.drafts.length > 0);
  const [nativeMode, setNativeMode] = useState<"comment" | "review">("comment");
  const selected =
    mode === "review" && !props.extensions?.review
      ? "comment"
      : mode === "comment" && !props.extensions?.comment
        ? "review"
        : mode;
  const action = selected === "review" ? props.extensions?.review : props.extensions?.comment;
  if (hostedOnly && !native && !nativeReview) return null;
  const disabled = props.context.disabled || pending || !body.trim();
  const send = async (close: boolean) => {
    const run = close ? props.extensions?.closeWithComment : action;
    if (disabled || !run) return;
    const submitted = body;
    setPending(true);
    try {
      await run(submitted, props.context);
      // Text typed while it posted stays, with the composer open.
      if (draft.clear(submitted)) {
        setOpen(false);
        setClosing(false);
      }
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
    <div className="absolute right-4 bottom-3 z-10">
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
        <PopoverContent side="top" align="end" className="w-96 max-w-full space-y-3 p-3">
          <PopoverTitle className="sr-only">Comment on pull request</PopoverTitle>
          <div className="flex items-center justify-between">
            {hostedOnly ? (
              <Tabs
                value={native ? nativeMode : "review"}
                onValueChange={(value) => {
                  if (value === "comment" || value === "review") setNativeMode(value);
                }}
              >
                <TabsList aria-label="Comment or review" className="rounded-md bg-muted p-0.5">
                  {native && <TabsTab value="comment">Comment</TabsTab>}
                  {nativeReview && <TabsTab value="review">Review</TabsTab>}
                </TabsList>
              </Tabs>
            ) : (
              <Tabs
                value={selected}
                onValueChange={(value) => {
                  if (value === "comment" || value === "review") {
                    setMode(value);
                    setClosing(false);
                  }
                }}
              >
                <TabsList aria-label="Comment or review" className="rounded-md bg-muted p-0.5">
                  {props.extensions?.comment && <TabsTab value="comment">Comment</TabsTab>}
                  {props.extensions?.review && <TabsTab value="review">Review</TabsTab>}
                </TabsList>
              </Tabs>
            )}
            <PopoverClose render={<IconButton icon={XIcon} label="Close composer" />} />
          </div>
          {hostedOnly ? (
            native && nativeMode === "comment" ? (
              <PrConversationComposer prKey={JSON.stringify(props.context.detail.status.ref)} />
            ) : (
              <PrReviewSubmission detail={props.context.detail} />
            )
          ) : (
            <>
              <MarkdownEditor
                autoFocus
                label={selected === "review" ? "Review body" : "Comment body"}
                placeholder={selected === "review" ? "Leave a review" : "Leave a comment"}
                value={body}
                onChange={(text) => {
                  draft.setText(text);
                  setClosing(false);
                }}
                onSubmit={() => void send(false)}
                maxLength={65_536}
              />
              {closing && (
                <p role="status" className="text-sm">
                  Close this pull request and post the comment?
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                {selected === "comment" && props.extensions?.closeWithComment && (
                  <Button
                    variant={closing ? "danger" : "ghost"}
                    tone={closing ? "default" : "danger"}
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
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
