import { formatClock, type HandoffEnd, type HandoffMarker } from "@ace/ui-core";
import { ArrowRightIcon, ArrowsLeftRightIcon } from "@phosphor-icons/react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import { CentredDivider } from "./centred-divider.tsx";

/** Source models drawn before the rest fold into "+N". */
const shownSources = 3;

/**
 * Where a thread moved to another provider and the new agent took the conversation over:
 * "⇄ Context handoff  GPT-6.1-Sol, Muse Spark → Claude Opus 5.5", each model with its own mark,
 * as a centred divider: the conversation itself changes hands here.
 */
export function HandoffDivider(props: { marker: HandoffMarker; at?: number | undefined }) {
  const { marker } = props;
  const shown = marker.from.slice(0, shownSources);
  const hidden = marker.from.length - shown.length;
  return (
    <CentredDivider
      label={marker.text}
      title={props.at === undefined ? undefined : formatClock(props.at)}
      icon={<ArrowsLeftRightIcon size={12} className="shrink-0" />}
    >
      <span className="font-medium">{marker.label}</span>
      {shown.map((side, index) => (
        <Endpoint
          key={`${side.provider}:${side.model ?? ""}`}
          side={side}
          comma={index < shown.length - 1 || hidden > 0}
        />
      ))}
      {hidden > 0 && <span>+{hidden}</span>}
      {shown.length > 0 && <ArrowRightIcon size={12} className="shrink-0" />}
      <Endpoint side={marker.to} target />
    </CentredDivider>
  );
}

/** One model: its mark in the brand's colours and its name; the target reads at full strength. */
function Endpoint(props: { side: HandoffEnd; target?: boolean; comma?: boolean }) {
  const { side } = props;
  return (
    <span className="inline-flex min-w-0 items-center">
      <ProviderIcon provider={side.provider} model={side.model} size={12} decorative />
      <span
        className={cn("ml-1 max-w-[24ch] truncate font-medium", props.target && "text-foreground")}
      >
        {side.name}
      </span>
      {props.comma && <span aria-hidden>,</span>}
    </span>
  );
}
