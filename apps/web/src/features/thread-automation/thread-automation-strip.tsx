import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { useNow } from "@/lib/time.ts";
import {
  actionLabel,
  automationLine,
  lineText,
  type AutomationLine,
  type LineAction,
} from "./automation-line.ts";
import { useSetThreadAutomationEnabled, useThreadAutomations } from "./use-thread-automations.ts";

/**
 * The sentence for the thread's automations, or undefined when it has none. The composer's
 * strip shows it only when nothing more urgent fills its slot.
 */
export function useThreadAutomationLine(threadId: string): AutomationLine | undefined {
  const entries = useThreadAutomations(threadId);
  const now = useNow();
  // The reader's zone, read once: a schedule kept in another zone names it.
  const [localZone] = useState(() => new Intl.DateTimeFormat().resolvedOptions().timeZone);
  return automationLine(entries, { now, localZone });
}

/**
 * One line in the composer's strip: the words, a status word in its colour, then text actions
 * at the right edge. No glyphs, no tint.
 */
export function ThreadAutomationStrip(props: { line: AutomationLine }) {
  const { line } = props;
  return (
    <div
      role="status"
      aria-label={lineText(line)}
      className="flex h-7 min-w-0 items-center gap-1.5 px-1 text-xs"
    >
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {line.segments.map((segment, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- segments are positional words.
          <Fragment key={index}>
            {index > 0 && " · "}
            {segment.status && (
              <span data-tone={segment.status.tone} className="font-medium text-(--tone-text)">
                {segment.status.word}
              </span>
            )}
            {segment.status && segment.text && " "}
            {segment.text && (
              <span className={index === 0 ? "text-foreground" : undefined}>{segment.text}</span>
            )}
          </Fragment>
        ))}
      </span>
      <span className="flex shrink-0 items-center">
        {line.actions.map((action) => (
          <Action key={action.kind} action={action} />
        ))}
      </span>
    </div>
  );
}

const linkClass = buttonVariants({ variant: "ghost", size: "xs" });

function Action(props: { action: LineAction }) {
  const { action } = props;
  switch (action.kind) {
    case "pause":
    case "resume":
      return <Toggle action={action} />;
    case "open-run":
      return (
        <Link to="/t/$threadId" params={{ threadId: action.threadId }} className={linkClass}>
          {actionLabel(action)}
        </Link>
      );
    case "open":
      return action.automationId === undefined ? (
        <Link to="/automations" className={linkClass}>
          {actionLabel(action)}
        </Link>
      ) : (
        <Link
          to="/automations/$automationId"
          params={{ automationId: action.automationId }}
          className={linkClass}
        >
          {actionLabel(action)}
        </Link>
      );
  }
}

function Toggle(props: { action: Extract<LineAction, { kind: "pause" | "resume" }> }) {
  const { action } = props;
  const setEnabled = useSetThreadAutomationEnabled();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void setEnabled(action.id, action.kind === "resume", action.revision).finally(() =>
          setBusy(false),
        );
      }}
    >
      {actionLabel(action)}
    </Button>
  );
}
