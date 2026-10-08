import type { ProviderKind } from "@ace/protocol";
import { serviceInfo, type ReadinessTone } from "@ace/ui-core";
import { StatusLabel } from "@/components/status-label.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * A provider (or a service it reaches) as the providers pages draw it: its mark on a small raised
 * tile, and its status as a dot in its tone beside one line of words.
 */

const tiles = {
  sm: { box: "size-8 rounded-sm", icon: 16 },
  md: { box: "size-10 rounded-md", icon: 20 },
  lg: { box: "size-12 rounded-card", icon: 24 },
} as const;

/** A provider's mark on a tile. `service` draws the mark of a service OpenCode or Pi reaches. */
export function ProviderTile(props: {
  provider: ProviderKind;
  acpAgentId?: string | undefined;
  /** A service id (`opencode-go`, `github-copilot`); its initial stands in for an unknown mark. */
  service?: { id: string; label: string } | undefined;
  size?: keyof typeof tiles;
  /** Not installed or turned off: the mark recedes. */
  muted?: boolean;
  className?: string;
}) {
  const tile = tiles[props.size ?? "md"];
  const brand = props.service ? serviceInfo(props.service.id).brand : undefined;
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center bg-secondary shadow-[inset_0_0_0_1px_var(--border)]",
        tile.box,
        props.muted && "opacity-60 grayscale",
        props.className,
      )}
    >
      {props.service && !brand ? (
        <span className="text-base font-semibold text-muted-foreground">
          {props.service.label.slice(0, 1).toUpperCase()}
        </span>
      ) : (
        <ProviderIcon
          provider={props.provider}
          acpAgentId={props.acpAgentId}
          brand={brand}
          size={tile.icon}
          decorative
        />
      )}
    </span>
  );
}

const dotTones = {
  ready: "done",
  action: "needs-you",
  problem: "failed",
  idle: "idle",
} as const;

/** "● Signed in as ada@example.com": a status in its tone, on one line. */
export function StatusLine(props: { tone: ReadinessTone; text: string; className?: string }) {
  return (
    <StatusLabel tone={dotTones[props.tone]} label={props.text} className={props.className ?? ""} />
  );
}
