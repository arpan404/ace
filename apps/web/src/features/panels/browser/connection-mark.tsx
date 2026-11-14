import { GlobeSimpleIcon, LockSimpleIcon, LockSimpleOpenIcon } from "@phosphor-icons/react";
import { pageConnection, pageConnectionLabels } from "@ace/ui-core";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

const glyphs = {
  secure: { icon: LockSimpleIcon, tone: "text-subtle-foreground" },
  insecure: { icon: LockSimpleOpenIcon, tone: "text-status-needs-you" },
  local: { icon: GlobeSimpleIcon, tone: "text-subtle-foreground" },
} as const;

/** The page's security mark at the address's start. */
export function ConnectionMark(props: { url: string | undefined }) {
  const connection = pageConnection(props.url);
  const glyph = { ...glyphs[connection], label: pageConnectionLabels[connection] };
  return (
    <Tip label={glyph.label}>
      <span
        role="img"
        aria-label={glyph.label}
        className={cn("grid size-6 shrink-0 place-items-center", glyph.tone)}
      >
        <glyph.icon aria-hidden size={14} />
      </span>
    </Tip>
  );
}
