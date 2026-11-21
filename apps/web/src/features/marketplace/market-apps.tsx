import { spadeAppCategories } from "@ace/ui-core/spade-chat";
import { useSpadeConnectors } from "@/features/spade/index.ts";
import { useSpadeShown } from "@/lib/spade-available.ts";
import { Empty } from "./market-card.tsx";
import { connectLine, isYours, storeApps, type StoreApp } from "./market-app-model.ts";
import { useMarketNav } from "./market-nav.ts";
import { AppRow, Shelf, StoreRows } from "./market-store-row.tsx";

/*
 * Apps: the services Spade's bots reach through their own servers (ADR 0131), as store entries.
 * Each has its page and connects right where it's shown, through Spade's one connect flow; the
 * listing is Spade's catalogue, joined with the person's connections.
 */

/** Spade's apps as store entries, once Spade is running and has answered; undefined otherwise. */
export function useMarketApps(): readonly StoreApp[] | undefined {
  const shown = useSpadeShown() === true;
  const read = useSpadeConnectors(shown);
  return shown && read.data ? storeApps(read.data.catalogue, read.data.connectors) : undefined;
}

/** Home's shelf: apps the person hasn't connected yet, in the catalogue's order. */
export function AppsShelf() {
  const nav = useMarketNav();
  const apps = useMarketApps();
  const shown = (apps ?? []).filter((app) => !isYours(app) && app.state !== "later").slice(0, 6);
  if (!shown.length) return null;
  return (
    <Shelf title="Apps that work with Spade" all={() => nav.go("apps")}>
      <StoreRows label="Apps that work with Spade">
        {shown.map((app) => (
          <AppRow key={app.id} app={app} />
        ))}
      </StoreRows>
    </Shelf>
  );
}

/** The Apps place: the person's own apps, then every other app by what it's for. */
export function AppsPage() {
  const apps = useMarketApps();
  if (!apps) return null;
  if (!apps.length) return <Empty title="No apps are listed yet" />;
  const yours = apps.filter(isYours);
  const rest = apps.filter((app) => !isYours(app));
  return (
    <div className="mk-inner">
      {yours.length > 0 && (
        <Shelf title="Your apps">
          <StoreRows label="Your apps">
            {yours.map((app) => (
              <AppRow key={app.id} app={app} />
            ))}
          </StoreRows>
        </Shelf>
      )}
      {spadeAppCategories.map((category) => {
        const inIt = rest.filter((app) => app.category === category.id);
        return inIt.length ? (
          <Shelf key={category.id} title={category.label}>
            <StoreRows label={category.label}>
              {inIt.map((app) => (
                <AppRow key={app.id} app={app} line={connectLine(app)} />
              ))}
            </StoreRows>
          </Shelf>
        ) : null;
      })}
    </div>
  );
}
