import type { ProviderKind } from "@ace/protocol";
import { providerDisplayName, type Brand, type BrandArt, type BrandPath } from "@ace/ui-core";
import { useEffect, useId, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn.ts";
import { Tip } from "./tooltip.tsx";

/*
 * Every provider, ACP agent and model-family mark in the app goes through this file: change the
 * drawing here and it changes everywhere. Which brand stands for what lives in
 * `@ace/ui-core/provider-icons` (`providerIcon`, `providerBrands`, `acpAgentBrands`,
 * `modelFamily`), shared with mobile.
 *
 * Marks draw in their brand's colours by default (Claude's orange, Codex's blue gradient); a
 * brand whose mark is black and white (OpenAI, Cursor, OpenCode) draws in the text colour at full
 * strength. `variant="mono"` draws any mark in the surrounding text colour, for a tiny inline mark.
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
  /** `color` (the default) uses the brand's colours; `mono` draws in the surrounding text colour. */
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
  const gradientId = useId();
  const choice = catalog?.providerIcon(props);
  const size = props.size ?? 12;
  const color = props.variant !== "mono";
  // In mono, at row sizes a detailed mark draws as its maker's simpler one (Codex → OpenAI); in
  // colour the brand's own colours keep it legible.
  const brand =
    choice?.brand && catalog && !color ? catalog.brandAtSize(choice.brand, size) : choice?.brand;
  const art = brand && marks.get(brand);
  const paths = art ? (color ? (art.color ?? art.mono) : art.mono) : undefined;
  const label =
    props.label ?? choice?.label ?? providerDisplayName(props.provider, props.acpAgentId);
  useEffect(() => load(brand), [brand]);
  return (
    <svg
      viewBox={art ? art.viewBox : "0 0 24 24"}
      width={size}
      height={size}
      // A black-and-white brand is drawn at full strength, like the coloured ones.
      className={cn(
        "inline-block shrink-0",
        color && art && !art.color && "text-foreground",
        props.className,
      )}
      {...(props.decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      {paths ? (
        <>
          {paths.some((path) => path.gradient) && (
            <defs>{paths.map((path, index) => gradientDef(path, `${gradientId}g${index}`))}</defs>
          )}
          {paths.map((path, index) => (
            <path
              key={path.d}
              d={path.d}
              fill={path.gradient ? `url(#${gradientId}g${index})` : (path.fill ?? "currentColor")}
              fillRule={path.fillRule}
              clipRule={path.clipRule}
              opacity={path.opacity}
            />
          ))}
        </>
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

function gradientDef(path: BrandPath, id: string) {
  const gradient = path.gradient;
  if (!gradient) return null;
  const Gradient = gradient.type === "radial" ? "radialGradient" : "linearGradient";
  return (
    <Gradient key={id} id={id} {...gradient.attributes}>
      {gradient.stops.map((stop, index) => (
        <stop
          // Stops never reorder.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          offset={stop.offset}
          stopColor={stop.color}
          stopOpacity={stop.opacity}
        />
      ))}
    </Gradient>
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
