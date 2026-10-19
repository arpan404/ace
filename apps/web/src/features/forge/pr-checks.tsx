import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  MinusCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ForgeCheck } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { openExternal } from "@/boot/open-external.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import type { PrWorkspaceContext } from "./pr-extensions.ts";
import { PrSection } from "./pr-section.tsx";

const checkLook: Record<
  ForgeCheck["status"],
  { icon: typeof CircleIcon; word: string; tone: string }
> = {
  success: { icon: CheckCircleIcon, word: "Passed", tone: "text-status-done" },
  failure: { icon: XCircleIcon, word: "Failed", tone: "text-status-failed" },
  pending: { icon: ClockIcon, word: "Running", tone: "text-status-working" },
  cancelled: { icon: MinusCircleIcon, word: "Cancelled", tone: "text-subtle-foreground" },
  unknown: { icon: CircleIcon, word: "Unknown", tone: "text-subtle-foreground" },
};

/**
 * The PR's checks, folded by default: each with its state and a click to open it. When the
 * host couldn't say, one inline Refresh, the panel's only one.
 */
export function PrChecks(props: {
  context: PrWorkspaceContext;
  refreshing: boolean;
  reveal?: number | undefined;
  onRefresh(): void;
}) {
  const { status } = props.context.detail;
  const toast = useToast();
  const stale = status.ci === "unknown";
  return (
    <PrSection
      id="pr-checks"
      title="Checks"
      count={status.checks.length || undefined}
      defaultOpen={false}
      reveal={props.reveal}
    >
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
                  className="flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-ui transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover disabled:hover:bg-transparent"
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
