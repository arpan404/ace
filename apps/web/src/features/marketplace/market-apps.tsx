import type { SpadeCatalogueEntry, SpadeConnector } from "@ace/ui-core/spade-chat";
import { SquaresLinkedIcon } from "@ace/icons";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button.tsx";
import { useSpadeConnectors } from "@/features/spade/index.ts";
import { useSpadeShown } from "@/lib/spade-available.ts";
import { part } from "@/lib/suit-part.ts";
import { Section } from "./market-card.tsx";
import { offlineTitle, useMarketNav } from "./market-nav.ts";
import { AppMark } from "./market-stage.tsx";

/*
 * Apps: the services Spade's bots reach through their own servers (ADR 0131). Connected ones
 * first, then the rest of Spade's catalogue, in three columns. Connect opens Spade's own flow in
 * Settings, where a sign-in, a token or a client ID is handled; nothing about an app is listed
 * in the market itself.
 */

interface AppRowData {
  id: string;
  name: string;
  line: string;
  connected: boolean;
}

function rowsOf(catalogue: readonly SpadeCatalogueEntry[], connectors: readonly SpadeConnector[]) {
  const connected: AppRowData[] = connectors.map((connector) => ({
    id: connector.id,
    name: connector.name,
    line: connector.account ?? connector.url.replace(/^https:\/\//, ""),
    connected: connector.state === "connected",
  }));
  const used = new Set(connectors.map((connector) => connector.catalogue).filter(Boolean));
  const rest: AppRowData[] = catalogue
    .filter((entry) => !used.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      line: entry.notes || entry.url.replace(/^https:\/\//, ""),
      connected: false,
    }));
  return { connected, rest };
}

/** Spade's apps, once Spade is running and has answered; undefined otherwise. */
export function useMarketApps() {
  const shown = useSpadeShown() === true;
  const read = useSpadeConnectors(shown);
  return shown && read.data ? rowsOf(read.data.catalogue, read.data.connectors) : undefined;
}

function AppRow(props: { app: AppRowData }) {
  const nav = useMarketNav();
  const navigate = useNavigate();
  const { app } = props;
  return (
    <li {...part("list-row", undefined, "market-app")} className="mk-row">
      <AppMark name={app.name} />
      <span className="mk-words">
        <span className="mk-name">{app.name}</span>
        <span className="mk-line mk-clamp1">{app.line}</span>
      </span>
      <span className="mk-actions">
        {app.connected ? (
          <span className="mk-state-word">Connected</span>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={nav.offline}
            title={nav.offline ? offlineTitle("Connect") : undefined}
            aria-label={`Connect ${app.name}`}
            onClick={() => {
              nav.close();
              void navigate({ to: "/settings/spade/apps" });
            }}
          >
            Connect
          </Button>
        )}
      </span>
    </li>
  );
}

/** Apps in three columns. */
export function AppColumns(props: { apps: readonly AppRowData[]; label: string }) {
  const per = Math.max(1, Math.ceil(props.apps.length / 3));
  return (
    <div className="mk-cols">
      {[0, 1, 2].map((column) => {
        const slice = props.apps.slice(column * per, column * per + per);
        return slice.length ? (
          <ul key={column} className="mk-rows" aria-label={column === 0 ? props.label : undefined}>
            {slice.map((app) => (
              <AppRow key={app.id} app={app} />
            ))}
          </ul>
        ) : null;
      })}
    </div>
  );
}

/** Discover's Apps shelf: six, with See all. */
export function AppsShelf() {
  const nav = useMarketNav();
  const apps = useMarketApps();
  const all = apps ? [...apps.connected, ...apps.rest] : [];
  if (!all.length) return null;
  return (
    <Section title="Apps" icon={SquaresLinkedIcon} all={() => nav.go("apps")}>
      <AppColumns apps={all.slice(0, 6)} label="Apps" />
    </Section>
  );
}

/** The Apps place: Connected, then More apps. */
export function AppsPage() {
  const apps = useMarketApps();
  if (!apps) return null;
  return (
    <div className="mk-inner">
      {apps.connected.length > 0 && (
        <Section title="Connected" first>
          <AppColumns apps={apps.connected} label="Connected" />
        </Section>
      )}
      {apps.rest.length > 0 && (
        <Section title="More apps" first={apps.connected.length === 0}>
          <AppColumns apps={apps.rest} label="More apps" />
        </Section>
      )}
    </div>
  );
}
