import type { BrandArt } from "@ace/ui-core/app-icons";
import { useEffect, useId, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { MarkPaths } from "./provider-icons.tsx";

/*
 * A connected app's mark on its neutral tile, wherever an app is named: the catalogue, a bot's
 * apps, Settings › Apps, a request that calls an app's tool. Marks are bundled
 * (`@ace/ui-core/app-icons`, sources in its LICENCES.md) and load as small chunks the first time
 * one is on screen; the tile keeps its size meanwhile. A server added by address, or an app with
 * no mark, shows its first letter on the same tile. Black-and-white brands draw in the text
 * colour, so every mark reads in light, dark and under Suits (the tile is the `avatar` part).
 */

type Tables = typeof import("@ace/ui-core/app-icons");

// Static, bounded by the catalogue: the tables once loaded and each mark drawn so far.
let tables: Tables | undefined;
let tablesLoading: Promise<void> | undefined;
let version = 0;
const marks = new Map<string, BrandArt>();
const requested = new Set<string>();
/** Apps asked for before the tables arrived; their marks load once the tables do. */
const wanted = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed() {
  version++;
  for (const listener of listeners) listener();
}

/** Loads the tables, then the app's mark. A failed load (offline) retries on a later mount. */
function load(id: string | undefined) {
  if (id) wanted.add(id);
  if (tables) return loadMark(tables, id);
  tablesLoading ??= import("@ace/ui-core/app-icons").then(
    (module) => {
      tables = module;
      for (const each of wanted) loadMark(module, each);
      changed();
    },
    () => {
      tablesLoading = undefined;
    },
  );
}

function loadMark(from: Tables, id: string | undefined) {
  const loader = id ? from.appArt[id] : undefined;
  if (!id || !loader || requested.has(id)) return;
  requested.add(id);
  loader().then(
    (art) => {
      marks.set(id, art);
      changed();
    },
    () => requested.delete(id),
  );
}

const sizes = {
  /** A list row's leading tile. */
  row: { tile: "size-7 rounded-lg text-xs", mark: 16 },
  /** Beside a name in a menu, a request or a step line. */
  inline: { tile: "size-5 rounded-md text-2xs", mark: 12 },
} as const;

/** An app's mark, by its catalogue id; its name's first letter when it has none. */
export function AppMark(props: {
  /** The catalogue entry the app came from; none for a server added by address. */
  catalogue: string | undefined;
  name: string;
  size?: keyof typeof sizes;
  className?: string | undefined;
}) {
  // Reads module state that only grows, by version; nothing worth memoising.
  "use no memo";
  useSyncExternalStore(subscribe, () => version);
  const gradientId = useId();
  const size = sizes[props.size ?? "row"];
  const id = props.catalogue;
  useEffect(() => load(id), [id]);
  const art = id ? marks.get(id) : undefined;
  const marked = Boolean(id && tables?.appArt[id]);
  return (
    <span
      aria-hidden
      {...part("avatar", undefined, "app")}
      data-app={id}
      className={cn(
        "grid shrink-0 place-items-center bg-surface-2 font-medium text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]",
        size.tile,
        props.className,
      )}
    >
      {art ? (
        <svg
          viewBox={art.viewBox}
          width={size.mark}
          height={size.mark}
          className={cn("block", !art.color && "text-foreground")}
        >
          <MarkPaths paths={art.color ?? art.mono} gradientId={gradientId} />
        </svg>
      ) : tables && !marked ? (
        tables.appMonogram(props.name)
      ) : null}
    </span>
  );
}
