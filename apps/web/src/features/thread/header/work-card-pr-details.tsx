import { useStackMemberships } from "@/features/forge/index.ts";
import type { ForgeCheck, ForgePrStatus } from "@ace/protocol";
import { mergeMethods, prOverview, type MergeMethod, type PrTone } from "@ace/ui-core";
import {
  ArrowSquareOutIcon,
  ChatsCircleIcon,
  CheckCircleIcon,
  ClockIcon,
  GitMergeIcon,
  MinusCircleIcon,
  UserPlusIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { SplitButton } from "@/components/ui/split-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { useGitFlow } from "./use-git-flow.tsx";
import { TruncatedText, RowNote, rowIcon } from "./work-card-parts.tsx";
import { openPullRequestLink as open } from "./work-card-pr-link.ts";

type GitFlow = ReturnType<typeof useGitFlow>;

/** A CI or check state as a glyph in its status colour. */
const tones: Record<PrTone | ForgeCheck["status"], { glyph: typeof ClockIcon; tone: string }> = {
  success: { glyph: CheckCircleIcon, tone: "text-status-done" },
  failure: { glyph: XCircleIcon, tone: "text-status-failed" },
  pending: { glyph: ClockIcon, tone: rowIcon },
  none: { glyph: MinusCircleIcon, tone: rowIcon },
  cancelled: { glyph: MinusCircleIcon, tone: rowIcon },
  unknown: { glyph: MinusCircleIcon, tone: rowIcon },
};
function ToneIcon(props: { tone: keyof typeof tones }) {
  const { glyph: Glyph, tone } = tones[props.tone];
  return <Glyph aria-hidden size={16} className={`shrink-0 ${tone}`} />;
}

export function PrDetails(props: {
  git: GitFlow;
  workspaceId: string;
  status: ForgePrStatus;
  base: string;
  onRequestReview?: (() => void) | undefined;
}) {
  const { git, status } = props;
  const toast = useToast();
  const membership = useStackMemberships(props.workspaceId, status.ref.repository, [
    status.ref.number,
  ]);
  const nativeStackOrUnknown =
    !membership.data || membership.isError || !!membership.data[0]?.stack;
  const stackReason = nativeStackOrUnknown
    ? "Open the full PR workspace to inspect native stack merge rules."
    : undefined;
  const view = prOverview(status, props.base);
  const [method, setMethod] = useState<MergeMethod>("squash");
  const label = mergeMethods.find((each) => each.method === method)?.label ?? "Merge";
  const settled = status.state === "merged" || status.state === "closed";
  return (
    <>
      <RowNote className="text-foreground">
        <ToneIcon tone={view.ci.tone} />
        {view.ci.text}
      </RowNote>
      {view.checks.length > 0 && (
        <ul aria-label="Checks">
          {view.checks.map((check) => (
            <li
              key={check.id}
              className="flex min-h-(--row-height) items-center gap-2.5 pr-1 pl-6 text-sm"
            >
              <ToneIcon tone={check.status} />
              <TruncatedText>{check.name}</TruncatedText>
              {check.url && (
                <IconButton
                  icon={ArrowSquareOutIcon}
                  label={`Open the ${check.name} logs`}
                  size="sm"
                  onClick={() =>
                    check.url &&
                    open(check.url, () => toast.error({ title: "Couldn't open the logs" }))
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {!settled && (
        <RowNote className="text-foreground">
          {view.merge.tone === "conflict" ? (
            <WarningIcon aria-hidden size={16} className="shrink-0 text-status-failed" />
          ) : (
            <GitMergeIcon aria-hidden size={16} className={rowIcon} />
          )}
          {view.merge.text}
        </RowNote>
      )}
      <RowNote className={view.unresolved ? "text-foreground" : undefined}>
        <ChatsCircleIcon aria-hidden size={16} className={rowIcon} />
        {view.unresolved
          ? `${view.unresolved} unresolved review ${view.unresolved === 1 ? "thread" : "threads"}`
          : "No unresolved review threads"}
      </RowNote>
      {!settled && (
        <div className="flex h-10 items-center gap-2 pr-1 pl-2.5">
          <SplitButton
            label={label}
            actionLabel={stackReason ?? view.mergeBlocked ?? `${label} into ${props.base}`}
            actionDisabled={nativeStackOrUnknown || !!view.mergeBlocked}
            className={view.mergeBlocked ? "text-muted-foreground" : ""}
            menuLabel="Merge options"
            disabled={git.pending}
            onAction={() =>
              git.run({
                kind: "merge",
                method,
                auto: false,
                headSha: status.headSha,
                pr: status.ref,
              })
            }
            menu={
              <>
                <MenuRadioGroup
                  value={method}
                  onValueChange={(value: MergeMethod) => setMethod(value)}
                >
                  {mergeMethods.map((each) => (
                    <MenuRadioItem key={each.method} value={each.method}>
                      {each.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
                <MenuSeparator />
                <MenuItem
                  icon={<ClockIcon aria-hidden size={16} />}
                  disabled={nativeStackOrUnknown || !!view.autoMergeBlocked}
                  reason={stackReason ?? view.autoMergeBlocked}
                  onClick={() =>
                    git.run({
                      kind: "merge",
                      method,
                      auto: true,
                      headSha: status.headSha,
                      pr: status.ref,
                    })
                  }
                >
                  Auto-merge when checks pass
                </MenuItem>
              </>
            }
          />
          <span className="min-w-0 flex-1 truncate text-sm text-subtle-foreground">
            {git.pending ? <Spinner label="Working on it" /> : view.mergeBlocked}
          </span>
          {props.onRequestReview && (
            <IconButton
              icon={UserPlusIcon}
              label="Request review…"
              size="sm"
              className="size-7"
              disabled={git.pending}
              onClick={props.onRequestReview}
            />
          )}
        </div>
      )}
    </>
  );
}
