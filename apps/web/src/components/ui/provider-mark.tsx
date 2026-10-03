import type { ProviderKind } from "@ace/protocol";
import { cn } from "@/lib/cn.ts";
import { Tip } from "./tooltip.tsx";

const names: Record<ProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  antigravity: "Antigravity",
  acp: "Gemini CLI",
};

export function providerName(provider: ProviderKind): string {
  return names[provider];
}

/* Simple monochrome marks drawn for ace: a burst, a ring, a bracket, a cursor, a star. */
const paths: Record<ProviderKind, string> = {
  claude:
    "M6 0.8v3.4M6 7.8v3.4M0.8 6h3.4M7.8 6h3.4M2.3 2.3l2.4 2.4M7.3 7.3l2.4 2.4M9.7 2.3L7.3 4.7M4.7 7.3L2.3 9.7",
  codex: "M6 1.2a4.8 4.8 0 1 0 0 9.6a4.8 4.8 0 1 0 0-9.6M4 6h4",
  opencode: "M4.2 2H2v8h2.2M7.8 2H10v8H7.8",
  cursor: "M2.2 1.6l7.6 4.2l-3.4 0.9l-0.9 3.5z",
  antigravity: "M6 1.5L10.5 10H1.5z",
  acp: "M6 0.8C6.4 4.2 7.8 5.6 11.2 6C7.8 6.4 6.4 7.8 6 11.2C5.6 7.8 4.2 6.4 0.8 6C4.2 5.6 5.6 4.2 6 0.8z",
};

/** A 12px monochrome provider glyph with the provider's name as tooltip and label. */
export function ProviderMark(props: { provider: ProviderKind; className?: string }) {
  const filled = props.provider === "acp" || props.provider === "cursor";
  return (
    <Tip label={names[props.provider]}>
      <svg
        role="img"
        aria-label={names[props.provider]}
        viewBox="0 0 12 12"
        width={12}
        height={12}
        className={cn("shrink-0 text-muted-foreground", props.className)}
      >
        <path
          d={paths[props.provider]}
          fill={filled ? "currentColor" : "none"}
          stroke={filled ? "none" : "currentColor"}
          strokeWidth={1.3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </Tip>
  );
}
