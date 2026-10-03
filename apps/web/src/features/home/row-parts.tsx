import { LaptopIcon, MoonIcon, PushPinIcon } from "@phosphor-icons/react";
import type { ProviderKind, ThreadStatus } from "@ace/protocol";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { ProviderGlyph, providerNames } from "@/components/ui/provider-glyph.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { threadStatusLabel } from "@/lib/status.ts";

/**
 * The only colour on a row: an amber dot for needs you, red for failed, a hollow ring for
 * unresponsive and a grey spinner while it works; waiting and done show nothing. The status word
 * is for assistive tech.
 */
export function StatusMark(props: { status: ThreadStatus }) {
  const { label } = threadStatusLabel(props.status);
  const mark = (() => {
    switch (props.status.state) {
      case "needs_you":
        return <Dot tone="needs-you" />;
      case "failed":
        return <Dot tone="failed" />;
      case "unresponsive":
        return <Dot tone="unresponsive" />;
      case "working":
        return <Spinner />;
      default:
        return null;
    }
  })();
  return (
    <>
      {mark}
      <span className="sr-only">{label}</span>
    </>
  );
}

/** Subagents beyond the root that are working right now, from the daemon's derived status. */
export function runningSubagents(status: ThreadStatus): number {
  return status.state === "working" ? Math.max(0, status.agents - 1) : 0;
}

/** Provider mark with the running subagent count beside it. */
export function ProviderMark(props: { provider: ProviderKind; subagents: number }) {
  const name = providerNames[props.provider];
  const label =
    props.subagents > 0
      ? `${name} · ${props.subagents} subagent${props.subagents === 1 ? "" : "s"} running`
      : name;
  return (
    <Tip label={label}>
      <span className="inline-flex items-center gap-[3px] text-xs text-subtle-foreground">
        <ProviderGlyph provider={props.provider} className="text-muted-foreground" />
        {props.subagents > 0 && <span aria-hidden>{props.subagents}</span>}
        <span className="sr-only">{label}</span>
      </span>
    </Tip>
  );
}

/** Line-one glyphs: another machine, pinned, snoozed. Each says what it means on hover. */
export function RowGlyphs(props: { machine?: string | undefined; pinned: boolean; wake?: string }) {
  return (
    <>
      {props.machine && <Glyph icon={LaptopIcon} label={`Running on ${props.machine}`} />}
      {props.pinned && <Glyph icon={PushPinIcon} label="Pinned" />}
      {props.wake && <Glyph icon={MoonIcon} label={`Snoozed until ${props.wake}`} />}
    </>
  );
}

function Glyph(props: { icon: typeof LaptopIcon; label: string }) {
  return (
    <Tip label={props.label}>
      <span className="inline-flex text-subtle-foreground">
        <Icon icon={props.icon} size={13} label={props.label} />
      </span>
    </Tip>
  );
}
