import { GlobeSimpleIcon, LockSimpleIcon, LockSimpleOpenIcon } from "@phosphor-icons/react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

/** How the page's connection reads: secure (https), not secure (http elsewhere), or local. */
function connection(url: string | undefined): "secure" | "insecure" | "local" {
  if (!url) return "local";
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`);
    if (parsed.protocol === "https:") return "secure";
    const host = parsed.hostname;
    return host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host.endsWith(".localhost")
      ? "local"
      : "insecure";
  } catch {
    return "local";
  }
}

const glyphs = {
  secure: { icon: LockSimpleIcon, label: "Secure connection", tone: "text-subtle-foreground" },
  insecure: { icon: LockSimpleOpenIcon, label: "Not secure", tone: "text-status-needs-you" },
  local: { icon: GlobeSimpleIcon, label: "Local page", tone: "text-subtle-foreground" },
} as const;

/** The page's security mark at the address's start. */
export function ConnectionMark(props: { url: string | undefined }) {
  const glyph = glyphs[connection(props.url)];
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
