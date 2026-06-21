import { CloudUploadIcon, GitCommitIcon, InfoIcon, RefreshCwIcon } from "lucide-react";

import type { GitQuickAction } from "../lib/git/actions";
import { GitHubIcon } from "./Icons";
import { Spinner } from "./ui/spinner";

export function GitQuickActionIcon({
  busy = false,
  quickAction,
}: {
  busy?: boolean;
  quickAction: GitQuickAction;
}) {
  const iconClassName = "size-3.5";
  if (busy) return <Spinner className={iconClassName} />;
  if (quickAction.kind === "open_pr") return <GitHubIcon className={iconClassName} />;
  if (quickAction.kind === "run_pull") return <RefreshCwIcon className={iconClassName} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={iconClassName} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={iconClassName} />;
    }
    return <GitHubIcon className={iconClassName} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={iconClassName} />;
  return <InfoIcon className={iconClassName} />;
}
