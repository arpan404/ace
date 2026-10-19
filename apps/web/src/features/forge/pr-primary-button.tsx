import { useEffect, useState } from "react";
import {
  CheckIcon,
  EyeIcon,
  GitMergeIcon,
  QueueIcon,
  TimerIcon,
  WarningIcon,
  XCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cardEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { prPrimaryLabel, type PrPrimary } from "./pr-primary-action.ts";

/** How long the first press of a merge waits for the second. */
const confirmWindowMs = 3_000;

const icons: Record<PrPrimary["kind"], Icon | undefined> = {
  state: undefined,
  resolve: WarningIcon,
  ready: EyeIcon,
  "auto-merge-armed": TimerIcon,
  queued: QueueIcon,
  "auto-merge": TimerIcon,
  merge: GitMergeIcon,
  none: undefined,
};

/** Labels fold away below this panel width; the icon and its tooltip stay. */
const label = "@max-[32rem]/pr:sr-only";

function StateBadge(props: { primary: PrPrimary; text: string }) {
  const merged = props.primary.kind === "state" && props.primary.state === "merged";
  const Glyph =
    props.primary.kind === "state"
      ? merged
        ? GitMergeIcon
        : XCircleIcon
      : icons[props.primary.kind];
  const tone =
    props.primary.kind === "state"
      ? merged
        ? "text-status-waiting"
        : "text-status-failed"
      : "text-status-working";
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-xs font-medium",
        cardEdge,
        tone,
      )}
    >
      {Glyph && <Glyph aria-hidden size={14} />}
      {props.text}
    </span>
  );
}

/**
 * The header's one primary control. Merging takes two presses: the first asks "Confirm merge?"
 * for a few seconds, the second acts. Merged and closed PRs, armed auto-merge and a queued PR
 * show a badge instead.
 */
export function PrPrimaryButton(props: {
  primary: PrPrimary;
  blocked: string | undefined;
  working: boolean;
  onRun(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), confirmWindowMs);
    return () => clearTimeout(timer);
  }, [confirming]);
  const { primary } = props;
  const text = prPrimaryLabel(primary);
  if (primary.kind === "none") return null;
  if (primary.kind === "state" || primary.kind === "auto-merge-armed" || primary.kind === "queued")
    return <StateBadge primary={primary} text={text} />;
  const twoPress = primary.kind === "merge" || primary.kind === "auto-merge";
  const Glyph = confirming ? CheckIcon : (icons[primary.kind] ?? GitMergeIcon);
  const shown = props.working
    ? primary.kind === "merge"
      ? "Merging…"
      : "Working…"
    : confirming
      ? primary.kind === "merge"
        ? "Confirm merge?"
        : "Confirm auto-merge?"
      : text;
  const button = (
    <Button
      size="xs"
      variant={primary.kind === "resolve" ? "secondary" : "primary"}
      tone={primary.kind === "resolve" ? "danger" : "default"}
      disabled={props.blocked !== undefined || props.working}
      aria-label={shown}
      onClick={() => {
        if (twoPress && !confirming) return setConfirming(true);
        setConfirming(false);
        props.onRun();
      }}
    >
      <Glyph aria-hidden size={14} />
      <span className={label}>{shown}</span>
    </Button>
  );
  // One wrapper whether or not it's blocked, so the button keeps its identity as state changes.
  // Blocked, the wrapper takes focus so its reason still reaches the keyboard.
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so a blocked button's reason reaches the keyboard
            tabIndex={props.blocked ? 0 : undefined}
            className="inline-flex rounded-sm focus-ring"
          />
        }
      >
        {button}
      </TooltipTrigger>
      <TooltipContent>{props.blocked ?? shown}</TooltipContent>
    </Tooltip>
  );
}
