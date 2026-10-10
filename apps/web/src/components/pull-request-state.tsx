import type { CheckoutPr } from "@ace/ui-core";
import { GitMergeIcon, GitPullRequestIcon } from "@phosphor-icons/react";

/** Shared state colours for work-card rows, hover previews and sidebar badges. */
export const pullRequestTone = (state: CheckoutPr["state"]) =>
  ({
    open: "text-status-done",
    draft: "text-subtle-foreground",
    merged: "text-status-waiting",
    closed: "text-status-failed",
  })[state];

export function PullRequestGlyph(props: { state: CheckoutPr["state"] | undefined; size: number }) {
  const Glyph = props.state === "merged" ? GitMergeIcon : GitPullRequestIcon;
  return (
    <Glyph
      aria-hidden
      size={props.size}
      className={props.state ? pullRequestTone(props.state) : "text-subtle-foreground"}
    />
  );
}
