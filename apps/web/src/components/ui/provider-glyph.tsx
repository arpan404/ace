import type { ProviderKind } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";
import { Tip } from "./tooltip.tsx";

const marks: Record<ProviderKind, ReactNode> = {
  claude: (
    <path
      d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      fill="none"
    />
  ),
  codex: (
    <>
      <path
        d="M8 1.6l5.5 3.2v6.4L8 14.4l-5.5-3.2V4.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </>
  ),
  opencode: (
    <>
      <rect
        x="2"
        y="2"
        width="12"
        height="12"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M5.3 6l2.4 2-2.4 2M8.6 10.3h2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  cursor: <path d="M3.2 2.2l10 6.3-4.4 1 2.4 4.4-1.9 1-2.4-4.4-3.7 2.6z" fill="currentColor" />,
  antigravity: (
    <path
      d="M8 1C8.2 5 11 7.8 15 8c-4 .2-6.8 3-7 7-.2-4-3-6.8-7-7 4-.2 6.8-3 7-7z"
      fill="currentColor"
    />
  ),
  acp: (
    <>
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" />
    </>
  ),
};

/**
 * 12px monochrome provider mark (DESIGN-fable.md "Provider glyphs"). Decorative unless
 * `label` is set; pair it with a tooltip or text naming the provider.
 */
export function ProviderGlyph(props: {
  provider: ProviderKind;
  label?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      data-slot="provider-glyph"
      className={cn("inline-block size-3 shrink-0", props.className)}
      {...(props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": true })}
    >
      {marks[props.provider]}
    </svg>
  );
}

/** The glyph with the provider's name as its label and tooltip, for places without text. */
export function ProviderMark(props: { provider: ProviderKind; className?: string }) {
  const name = providerNames[props.provider];
  return (
    <Tip label={name}>
      <ProviderGlyph
        provider={props.provider}
        label={name}
        className={cn("text-muted-foreground", props.className)}
      />
    </Tip>
  );
}
