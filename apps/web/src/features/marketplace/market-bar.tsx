import { MagnifyingGlassIcon, XIcon } from "@ace/icons";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { part } from "@/lib/suit-part.ts";
import type { MarketPlace } from "./market-address.ts";
import { useMarketInstalled } from "./market-api.ts";
import { useMarketApps } from "./market-apps.tsx";
import { Avatar } from "./market-marks.tsx";
import { useMarketNav } from "./market-nav.ts";
import { useMarketMe, useMarketPicture } from "./market-publishing.ts";

/*
 * The modal's one bar, read left to right as the person works: Marketplace · the five places ·
 * search · Installed (with its update count) · you · Close. It never changes as pages push over
 * a place, so search, Installed and Close are always one click away. Its grid takes one, two or
 * three rows by the modal's width (market-widths.css).
 */

const places: readonly { id: MarketPlace; name: string }[] = [
  { id: "discover", name: "Discover" },
  { id: "looks", name: "Looks" },
  { id: "bots", name: "Bots" },
  { id: "tools", name: "Tools" },
  { id: "apps", name: "Apps" },
];

const placeholders: Readonly<Record<MarketPlace, string>> = {
  discover: "Search the marketplace",
  looks: "Search looks",
  bots: "Search bots",
  tools: "Search skills and plugins",
  apps: "Search apps",
  installed: "Search the marketplace",
};

export function MarketBar(props: {
  query: string;
  onQuery(query: string): void;
  edge: boolean;
  onClose(): void;
}) {
  const nav = useMarketNav();
  const { view } = nav;
  const installed = useMarketInstalled().data?.installed;
  const updates = installed?.filter((item) => item.update).length ?? 0;
  const apps = useMarketApps();
  const { me, signedOut } = useMarketMe();
  const avatar = useMarketPicture("avatar", me?.profile?.avatar);
  const top = view.pages.at(-1);
  const shown = places.filter(
    (place) => (place.id !== "looks" || view.scope !== "spade") && (place.id !== "apps" || apps),
  );
  const current = (id: MarketPlace) => (view.place === id && !props.query ? "page" : undefined);
  const installedTab = (className: string) => (
    <button
      type="button"
      className={`mk-tab ${className}`}
      aria-current={current("installed")}
      onClick={() => nav.go("installed")}
    >
      Installed
      {/* Only what the marketplace installed: no count at zero, as built-in Suits aren't counted. */}
      {installed?.length ? <span className="mk-count">{updates || installed.length}</span> : null}
    </button>
  );
  const placeholder =
    placeholders[view.scope === "spade" && view.place === "discover" ? "tools" : view.place];
  return (
    <header
      {...part("page-toolbar", undefined, "market")}
      className="mk-bar"
      data-edge={props.edge ? "" : undefined}
    >
      <h2 className="mk-bar-title" id="market-title">
        Marketplace
      </h2>
      <nav className="mk-tabs" aria-label="Marketplace">
        {shown.map((place) => (
          <button
            key={place.id}
            type="button"
            {...part("tab", current(place.id) && "selected")}
            className="mk-tab"
            aria-current={current(place.id)}
            onClick={() => nav.go(place.id)}
          >
            {place.name}
          </button>
        ))}
        {installedTab("mk-phone-only")}
      </nav>
      <label {...part("search-field", undefined, "market")} className="mk-search">
        <MagnifyingGlassIcon aria-hidden size={14} />
        <input
          type="search"
          value={props.query}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => props.onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && props.query) {
              event.stopPropagation();
              event.nativeEvent.stopImmediatePropagation();
              props.onQuery("");
            }
          }}
        />
      </label>
      {installedTab("mk-installed-tab")}
      <span className="mk-bar-me">
        {me?.profile ? (
          <button
            type="button"
            className="mk-me"
            aria-label="Your profile"
            title="Your profile"
            aria-current={top?.kind === "profile" ? "page" : undefined}
            onClick={() => top?.kind !== "profile" && nav.push({ kind: "profile" })}
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              margin: "0 4px",
            }}
          >
            <Avatar name={me.profile.displayName} size={30} picture={avatar} />
          </button>
        ) : signedOut ? (
          <Button variant="secondary" onClick={() => nav.push({ kind: "profile" })}>
            Sign in to publish
          </Button>
        ) : me ? (
          <Button variant="secondary" onClick={() => nav.push({ kind: "profile" })}>
            Make your profile
          </Button>
        ) : null}
      </span>
      <IconButton
        icon={XIcon}
        label="Close"
        keys="Esc"
        resolve={false}
        className="mk-bar-close"
        onClick={props.onClose}
      />
    </header>
  );
}
