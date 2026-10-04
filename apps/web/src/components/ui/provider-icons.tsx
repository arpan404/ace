import type { ProviderKind } from "@ace/protocol";
import { providerDisplayName, type Brand, type BrandArt } from "@ace/ui-core";
import { useEffect, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn.ts";
import { Tip } from "./tooltip.tsx";

/*
 * Every provider, ACP agent and model-family mark in the app goes through this file: change the
 * drawing here and it changes everywhere. Which brand stands for what lives in
 * `@ace/ui-core/provider-icons` (`providerIcon`, `providerBrands`, `acpAgentBrands`,
 * `modelFamily`), shared with mobile.
 *
 * The marks are LobeHub Icons (MIT, see NOTICE) as path data. The brand tables and each mark load
 * as small chunks the first time a mark is on screen, so none of them weighs on the first paint;
 * the box keeps its size meanwhile, so nothing shifts when the mark arrives.
 */

type Catalog = typeof import("@ace/ui-core/provider-icons");

// Static, bounded by the brand list: the tables once loaded and each mark drawn so far.
let catalog: Catalog | undefined;
let catalogLoading: Promise<void> | undefined;
let version = 0;
const marks = new Map<Brand, BrandArt>();
const requested = new Set<Brand>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed() {
  version++;
  for (const listener of listeners) listener();
}

/** Loads the tables, then the brand's mark. A failed load (offline) retries on a later mount. */
function load(brand: Brand | undefined) {
  if (!catalog) {
    catalogLoading ??= import("@ace/ui-core/provider-icons").then(
      (module) => {
        catalog = module;
        changed();
      },
      () => {
        catalogLoading = undefined;
      },
    );
  } else if (brand && !requested.has(brand)) {
    requested.add(brand);
    catalog.brandArt[brand]().then(
      (art) => {
        marks.set(brand, art);
        changed();
      },
      () => requested.delete(brand),
    );
  }
}

export interface ProviderIconProps {
  provider: ProviderKind;
  /** For ACP threads: the registry id that picks the agent's own mark. */
  acpAgentId?: string | undefined;
  /** A model id or name; its family's mark (Claude, OpenAI, Gemini…) wins when one is known. */
  model?: string | undefined;
  /** 12 dense rows · 14 menus and chips · 16 headings · 20 settings and empty states. */
  size?: 12 | 14 | 16 | 20;
  /** `mono` draws in the text colour and suits every theme; `color` uses the brand's colours. */
  variant?: "mono" | "color";
  /** Overrides the name read to assistive tech. */
  label?: string | undefined;
  /** Hide from assistive tech when text beside it already names the provider. */
  decorative?: boolean;
  className?: string | undefined;
}

/** A provider, ACP agent or model-family mark at a whole-pixel size. */
export function ProviderIcon(props: ProviderIconProps) {
  // Reads module state that only grows, by version; nothing worth memoising.
  "use no memo";
  useSyncExternalStore(subscribe, () => version);
  const choice = catalog?.providerIcon(props);
  const brand = choice?.brand;
  const art = brand && marks.get(brand);
  const label =
    props.label ?? choice?.label ?? providerDisplayName(props.provider, props.acpAgentId);
  const size = props.size ?? 12;
  useEffect(() => load(brand), [brand]);
  return (
    <svg
      viewBox={art ? art.viewBox : "0 0 24 24"}
      width={size}
      height={size}
      className={cn("inline-block shrink-0", props.className)}
      {...(props.decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      {art ? (
        (props.variant === "color" ? (art.color ?? art.mono) : art.mono).map((path) => (
          <path
            key={path.d}
            d={path.d}
            fill={path.fill ?? "currentColor"}
            fillRule={path.fillRule}
            clipRule={path.clipRule}
            opacity={path.opacity}
          />
        ))
      ) : choice && !brand ? (
        // ace's own mark for an agent without a brand of its own: a ring around a point.
        <>
          <circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="12" cy="12" r="2.75" fill="currentColor" />
        </>
      ) : null}
    </svg>
  );
}

/** The mark with its name as a tooltip, for places that show no text naming the provider. */
export function ProviderIconTip(props: Omit<ProviderIconProps, "decorative">) {
  "use no memo";
  useSyncExternalStore(subscribe, () => version);
  const label =
    props.label ??
    catalog?.providerIcon(props).label ??
    providerDisplayName(props.provider, props.acpAgentId);
  return (
    <Tip label={label}>
      <span className={cn("inline-flex text-muted-foreground", props.className)}>
        <ProviderIcon {...props} label={label} className={undefined} />
      </span>
    </Tip>
  );
}
