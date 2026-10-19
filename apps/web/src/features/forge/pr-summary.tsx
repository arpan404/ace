import { useState, type ReactNode } from "react";
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  MinusCircleIcon,
  PencilSimpleIcon,
  PlusIcon,
  TagIcon,
  UsersIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ForgeCheck } from "@ace/protocol";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { openExternal } from "@/boot/open-external.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { PrMarkdown } from "./pr-markdown.tsx";
import { PrAvatar } from "./pr-presentation.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrSection } from "./pr-section.tsx";
import { PrComments } from "./pr-comments.tsx";
import { reviewerOutcomes, reviewOutcomeLabels, type ReviewOutcome } from "./pr-summary-model.ts";

const ring: Record<ReviewOutcome, string> = {
  approved: "ring-status-done",
  changes: "ring-status-failed",
  commented: "ring-border",
  dismissed: "ring-border",
};

const checkLook: Record<
  ForgeCheck["status"],
  { icon: typeof CircleIcon; word: string; tone: string }
> = {
  success: { icon: CheckCircleIcon, word: "Passed", tone: "text-status-done" },
  failure: { icon: XCircleIcon, word: "Failed", tone: "text-status-failed" },
  pending: { icon: ClockIcon, word: "Running", tone: "text-status-needs-you" },
  cancelled: { icon: MinusCircleIcon, word: "Cancelled", tone: "text-subtle-foreground" },
  unknown: { icon: CircleIcon, word: "Unknown", tone: "text-subtle-foreground" },
};

/** Descriptions longer than this many lines fold behind Show more. */
const clampLines = 12;

function MetaRow(props: { icon: typeof UsersIcon; label: string; children: ReactNode }) {
  const Glyph = props.icon;
  return (
    <div className="grid min-h-6 grid-cols-[96px_minmax(0,1fr)] items-center">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Glyph aria-hidden size={14} className="text-faint-foreground" />
        {props.label}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1">{props.children}</dd>
    </div>
  );
}

function Description(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  onOpen(number: number): void;
  onEdit: (() => void) | undefined;
}) {
  const body = props.context.detail.body;
  const long = body.split("\n").length > clampLines || body.length > clampLines * 100;
  const [expanded, setExpanded] = useState(false);
  const edit = props.extensions?.editDescription
    ? () => props.extensions?.editDescription?.(props.context)
    : props.onEdit;
  return (
    <PrSection
      title="Description"
      action={
        edit && (
          <IconButton
            icon={PencilSimpleIcon}
            label="Edit description"
            size="sm"
            disabled={props.context.disabled}
            onClick={edit}
          />
        )
      }
    >
      {body.trim() ? (
        <div>
          <div className={cn(long && !expanded && "max-h-72 overflow-hidden")}>
            <PrMarkdown
              context={props.context}
              extensions={props.extensions}
              onOpen={props.onOpen}
              text={body}
            />
          </div>
          {long && (
            <Button variant="ghost" size="xs" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Show more"}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-ui text-muted-foreground italic">No description provided.</p>
      )}
    </PrSection>
  );
}

function Checks(props: { context: PrWorkspaceContext; refreshing: boolean; onRefresh(): void }) {
  const { status } = props.context.detail;
  const toast = useToast();
  const stale = status.ci === "unknown";
  return (
    <PrSection title="Checks" defaultOpen={false}>
      {stale && (
        <p className="flex items-center gap-2 text-ui text-muted-foreground">
          Check details are out of date.
          <Button variant="ghost" size="xs" disabled={props.refreshing} onClick={props.onRefresh}>
            <ArrowClockwiseIcon aria-hidden size={14} />
            Refresh
          </Button>
        </p>
      )}
      {status.checks.length ? (
        <ul>
          {status.checks.map((check) => {
            const look = checkLook[check.status];
            const Glyph = look.icon;
            const url = check.url;
            return (
              <li key={check.id}>
                <button
                  type="button"
                  disabled={!url}
                  aria-label={`${check.name}: ${look.word}`}
                  onClick={() =>
                    url &&
                    void openExternal(url).catch(() =>
                      toast.error({ title: "Couldn't open the check" }),
                    )
                  }
                  className="flex min-h-7 w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-ui focus-ring-inset hover:bg-accent disabled:hover:bg-transparent"
                >
                  <Glyph aria-hidden size={14} className={cn("shrink-0", look.tone)} />
                  <span className="min-w-0 flex-1 break-words">{check.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{look.word}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        !stale && <p className="text-ui text-muted-foreground">No checks reported.</p>
      )}
    </PrSection>
  );
}

/**
 * The Summary tab: reviewers and labels, the description, the checks (folded) and the
 * conversation. Every write lives in the header and its ⋯ menu.
 */
export function PrSummary(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  refreshing: boolean;
  onRefresh(): void;
  onOpen(number: number): void;
  /** Opens the reviewer request, when this PR can take one. */
  onRequestReview: (() => void) | undefined;
  /** Opens the details editor, when GitHub lets this account edit them. */
  onEdit: (() => void) | undefined;
}) {
  const { detail } = props.context;
  const outcomes = reviewerOutcomes(detail.status.comments);
  const reviewerPicker =
    props.extensions?.reviewers?.(props.context) ??
    (props.onRequestReview && (
      <IconButton
        icon={PlusIcon}
        label="Request review"
        size="sm"
        disabled={props.context.disabled}
        onClick={props.onRequestReview}
      />
    ));
  const labelPicker =
    props.extensions?.labels?.(props.context) ??
    (props.onEdit && (
      <IconButton
        icon={PlusIcon}
        label="Edit labels"
        size="sm"
        disabled={props.context.disabled}
        onClick={props.onEdit}
      />
    ));
  return (
    <div className="space-y-2 px-4 pt-2.5 pb-16">
      <dl className="space-y-1 pb-1">
        <MetaRow icon={UsersIcon} label="Reviewers">
          {detail.reviewers.length ? (
            <span className="flex -space-x-1">
              {detail.reviewers.map((name) => {
                const outcome = outcomes.get(name);
                const said = outcome ? `${name} — ${reviewOutcomeLabels[outcome]}` : name;
                return (
                  <Tip key={name} label={said}>
                    <span
                      aria-label={said}
                      className={cn(
                        "inline-flex rounded-full ring-2 ring-offset-1 ring-offset-panel",
                        outcome ? ring[outcome] : "ring-transparent",
                      )}
                    >
                      <PrAvatar name={name} url={detail.reviewerAvatars?.[name]} />
                    </span>
                  </Tip>
                );
              })}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">None</span>
          )}
          {reviewerPicker}
        </MetaRow>
        {(detail.labels.length > 0 || labelPicker) && (
          <MetaRow icon={TagIcon} label="Labels">
            {detail.labels.map((label) => (
              <span
                key={label}
                title={label}
                className="max-w-48 truncate rounded-xs bg-accent px-1.5 text-xs leading-5"
              >
                {label}
              </span>
            ))}
            {!detail.labels.length && <span className="text-xs text-muted-foreground">None</span>}
            {labelPicker}
          </MetaRow>
        )}
      </dl>
      <Description
        context={props.context}
        extensions={props.extensions}
        onOpen={props.onOpen}
        onEdit={props.onEdit}
      />
      <Checks context={props.context} refreshing={props.refreshing} onRefresh={props.onRefresh} />
      <PrComments status={detail.status} />
      {props.extensions?.summary?.(props.context)}
    </div>
  );
}
