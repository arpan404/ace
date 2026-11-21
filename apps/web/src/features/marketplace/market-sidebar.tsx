import {
  AppWindowIcon,
  DownloadSimpleIcon,
  HouseSimpleIcon,
  PaletteIcon,
  PuzzlePieceIcon,
  RobotIcon,
  UserCircleIcon,
} from "@ace/icons";
import type { IconGlyph } from "@/components/icon.tsx";
import { panelRow, PanelRowBody, PanelSearch } from "@/components/ui/panel.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import type { MarketPlace } from "./market-address.ts";
import { useMarketInstalled } from "./market-api.ts";
import { useMarketApps } from "./market-apps.tsx";
import { useMarketNav } from "./market-nav.ts";
import { useMarketMe } from "./market-publishing.ts";

/*
 * The Marketplace's panel, as Settings' is: its search over everything, then its places (Home,
 * Bots, Apps, Tools, Looks), then Installed with the count of updates waiting, and you. The page
 * beside it is the place or entry the address names.
 */

const places: readonly { id: MarketPlace; name: string; icon: IconGlyph }[] = [
  { id: "discover", name: "Home", icon: HouseSimpleIcon },
  { id: "bots", name: "Bots", icon: RobotIcon },
  { id: "apps", name: "Apps", icon: AppWindowIcon },
  { id: "tools", name: "Tools", icon: PuzzlePieceIcon },
  { id: "looks", name: "Looks", icon: PaletteIcon },
];

export function MarketSidebar(props: { query: string; onQuery(query: string): void }) {
  const nav = useMarketNav();
  const { view } = nav;
  const apps = useMarketApps();
  const installed = useMarketInstalled().data?.installed;
  const updates = installed?.filter((item) => item.update).length ?? 0;
  const { me, signedOut } = useMarketMe();
  const top = view.pages.at(-1);
  const shown = places.filter(
    (place) => (place.id !== "looks" || view.scope !== "spade") && (place.id !== "apps" || apps),
  );
  // The place the person is in, unless a search or a page of their own covers it.
  const current = (id: MarketPlace) =>
    view.place === id && !props.query && top?.kind !== "profile" ? "page" : undefined;
  const row = (id: MarketPlace, name: string, icon: IconGlyph, trailing?: number) => (
    <li key={id}>
      <button
        type="button"
        {...panelRow()}
        aria-current={current(id)}
        onClick={() => {
          props.onQuery("");
          nav.go(id);
        }}
      >
        <PanelRowBody
          icon={icon}
          title={name}
          trailing={
            trailing ? (
              <span
                className="text-ui text-muted-foreground"
                aria-label={`${trailing} ${trailing === 1 ? "update" : "updates"}`}
              >
                {trailing}
              </span>
            ) : undefined
          }
        />
      </button>
    </li>
  );
  return (
    <ViewSidebar
      title="Marketplace"
      toolbar={
        <PanelSearch
          label="Search bots, apps and more"
          placeholder="Search bots, apps and more"
          value={props.query}
          onValueChange={props.onQuery}
        />
      }
    >
      <nav aria-label="Marketplace" data-part="market-nav">
        <ul className="mt-1 flex flex-col gap-px">
          {shown.map((place) => row(place.id, place.name, place.icon))}
        </ul>
        <ul className="mt-5 flex flex-col gap-px">
          {row("installed", "Installed", DownloadSimpleIcon, updates)}
          {(me || signedOut) && (
            <li>
              <button
                type="button"
                {...panelRow()}
                aria-current={top?.kind === "profile" ? "page" : undefined}
                onClick={() => top?.kind !== "profile" && nav.push({ kind: "profile" })}
              >
                <PanelRowBody
                  icon={UserCircleIcon}
                  title={
                    me?.profile
                      ? "Your profile"
                      : signedOut
                        ? "Sign in to publish"
                        : "Make your profile"
                  }
                />
              </button>
            </li>
          )}
        </ul>
      </nav>
    </ViewSidebar>
  );
}
