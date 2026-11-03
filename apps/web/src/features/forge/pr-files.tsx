import { useEffect, useRef, useState } from "react";
import {
  allCommits,
  codeRange,
  sinceLastReview,
  type CodeRange,
  type CodeScope,
} from "@ace/ui-core";
import { DeferredFileDiffBlock, DeferredFileTree } from "@/features/panels/index.ts";
import { useNow } from "@/lib/time.ts";
import { usePrCommits } from "./pr-commits.tsx";
import { useCodeOptions } from "./pr-code-options.ts";
import { PrCodeRange } from "./pr-code-range.tsx";
import type { PrFilesProps } from "./pr-files-props.ts";
import { usePrReviewers } from "./pr-reviewers-query.ts";

/** Warm the diff renderer while a pull request is open, before its Code tab is chosen. */
export function preloadPrFiles(): void {
  void DeferredFileDiffBlock.preload().catch(() => {});
  void DeferredFileTree.preload().catch(() => {});
}

const rangeKey = (range: CodeRange) => `${range.since ?? ""}..${range.commit}`;

/**
 * The Code tab: every changed file of the pull request (or of a span of its commits) in one
 * continuous scroll, read page by page as it nears the end, with the files tree beside it.
 * How it draws (layout, wrap, tree, whitespace) is kept on this device, and the commit choice
 * and the file being read are held here, above the range: a push reads the new head's files
 * and keeps all of it.
 */
export function PrFiles(props: PrFilesProps) {
  const [options, setOptions] = useCodeOptions();
  const [ownScope, setOwnScope] = useState<CodeScope>(allCommits);
  const scope = props.scope ?? ownScope;
  const onScope = props.onScope ?? setOwnScope;
  const commits = usePrCommits(props);
  const reviewers = usePrReviewers(props.workspaceId, props.detail);
  const head = props.detail.status.headSha;
  const list = commits.data?.commits ?? noCommits;
  const since = reviewers.data ? sinceLastReview(reviewers.data, list, head) : undefined;
  const range = codeRange(scope, list, since);
  // The file being read, kept across a push so the new head opens where the person was.
  const [place, setPlace] = useState<string>();
  const pushedAt = usePushedAt(head, list);
  return (
    <PrCodeRange
      key={`${head}/${props.detail.baseSha}/${rangeKey(range)}`}
      {...props}
      range={range}
      scope={scope}
      onScope={onScope}
      since={since}
      commits={commits}
      options={options}
      onOptions={setOptions}
      place={place}
      onPlace={setPlace}
      pushedAt={pushedAt}
    />
  );
}

/**
 * When the head last moved while the tab was open: the new head commit's date when it is
 * listed, else when ace saw the push. Undefined until a push is seen.
 */
function usePushedAt(head: string, commits: readonly { sha: string; date: string | null }[]) {
  const now = useNow();
  const first = useRef(head);
  const [seenAt, setSeenAt] = useState<number>();
  useEffect(() => {
    if (head !== first.current) setSeenAt(now);
    // Only a new head marks a push; the clock ticking doesn't.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [head]);
  if (seenAt === undefined) return undefined;
  const date = commits.find((commit) => commit.sha === head)?.date;
  const at = date ? Date.parse(date) : Number.NaN;
  return Number.isNaN(at) ? seenAt : Math.min(at, seenAt);
}

const noCommits: readonly never[] = [];
