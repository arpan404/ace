import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  AppBotFaces,
  botsUsing,
  connectorsKey,
  disconnect,
  useAppConnect,
  useMachineBots,
  UseInAnotherBot,
  useSpadeClient,
} from "@/features/spade/index.ts";
import { part } from "@/lib/suit-part.ts";
import { useMarketApps } from "./market-apps.tsx";
import { categoryLabel, signInWords, type StoreApp } from "./market-app-model.ts";
import { Empty } from "./market-card.tsx";
import { AppIcon } from "./market-store-row.tsx";

/*
 * One app's page in the store: its mark, name and what it's for, and one primary action for
 * where the person stands with it: Connect (or Add a key) while it isn't connected, Reconnect
 * once its sign-in ended, and Use in another bot once it works. The sign-in is followed in
 * place; a failure says what fixes it. Under it: what it is, how it signs in, and the bots that
 * use it, with Disconnect as a quiet word at the end.
 */

export function AppPage(props: { id: string }) {
  const apps = useMarketApps();
  if (!apps) return null;
  const app = apps.find((each) => each.id === props.id);
  if (!app) return <Empty title="Spade doesn't list this app" />;
  return <AppDetail key={app.id} app={app} />;
}

/** "Connected as sam@acme.dev", "Signed out", or nothing while it isn't connected. */
function stateSentence(app: StoreApp): string | undefined {
  const account = app.connector?.account;
  switch (app.state) {
    case "connected":
      return account ? `Connected as ${account}.` : "Connected.";
    case "signed_out":
      return `Signed out. Reconnect so your bots can use ${app.name} again.`;
    case "unreachable":
      return app.connector?.problem
        ? `Spade can't reach ${app.name}: ${app.connector.problem}.`
        : `Spade can't reach ${app.name} right now.`;
    case "connecting":
      return "Finishing the sign-in.";
    default:
      return undefined;
  }
}

function AppDetail(props: { app: StoreApp }) {
  const { app } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const bots = useMachineBots().data ?? [];
  const [leaving, setLeaving] = useState(false);
  const connect = useAppConnect({
    app: {
      catalogue: app.catalogue,
      name: app.name,
      connector: app.state === "signed_out" ? app.connector : undefined,
      ready: app.ready,
      keyUrl: app.keyUrl,
    },
    size: "lg",
    primary: true,
  });
  const connector = app.connector;
  const users = connector ? botsUsing(connector, bots) : [];
  const working = app.state === "connected" || app.state === "unreachable";
  const said = stateSentence(app);
  const remove = async () => {
    if (!connector) return;
    setLeaving(true);
    try {
      await disconnect(client, connector.id);
    } finally {
      setLeaving(false);
      await cache.invalidateQueries({ queryKey: connectorsKey });
    }
  };
  return (
    <article className="st-page" aria-label={app.name}>
      <header className="st-head">
        <AppIcon app={app} size="page" />
        <div className="st-head-words">
          <h1 {...part("page-title", undefined, "market")} className="st-title">
            {app.name}
          </h1>
          <p className="st-lead">{categoryLabel(app.category)}</p>
          {said && <p className="st-status">{said}</p>}
          <div className="st-actions">
            {working && connector ? (
              <UseInAnotherBot connector={connector} size="lg" />
            ) : app.state === "later" ? (
              <span className="st-state">Not available yet</span>
            ) : (
              connect.action
            )}
          </div>
          {connect.status && <div className="st-status">{connect.status}</div>}
        </div>
      </header>
      {connector && (
        <section className="st-section" aria-label="Bots that use it">
          <h2>Bots that use it</h2>
          {users.length ? (
            <div className="flex items-center gap-3 text-base">
              <AppBotFaces bots={users} size={28} />
              <span>{users.map((bot) => bot.name).join(", ")}</span>
            </div>
          ) : (
            <p className="st-prose">No bot uses it yet.</p>
          )}
        </section>
      )}
      <section className="st-section" aria-label="How it connects">
        <h2>How it connects</h2>
        <p className="st-prose">{signInWords(app)}</p>
        {app.notes && (
          <p className="st-prose" style={{ marginTop: 8, color: "var(--mk-muted)" }}>
            {app.notes}
          </p>
        )}
      </section>
      {connector && (
        <section className="st-section" aria-label="Disconnect">
          <Button variant="ghost" disabled={leaving} onClick={() => void remove()}>
            {`Disconnect ${app.name}`}
          </Button>
        </section>
      )}
    </article>
  );
}
