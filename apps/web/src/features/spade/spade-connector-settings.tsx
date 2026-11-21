import {
  spadeCloudLine,
  spadeConnectorHealth,
  spadeConnectorLine,
  spadeLastUsedWords,
  type SpadeConnector,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  SettingAddRow,
  SettingCard,
  SettingRow,
  settingsGroup,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { openExternal } from "@/boot/open-external.ts";
import { AppMark } from "@/components/ui/app-mark.tsx";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";
import { useOpenMarket } from "@/lib/open-market.ts";
import { AddConnectorDialog } from "./spade-add-connector.tsx";
import { UseInAnotherBot } from "./spade-app-bots.tsx";
import { useAppConnect } from "./spade-app-connect.tsx";
import { connectHere } from "./spade-connect-flow.ts";
import { connectorsKey, disconnect, reconnect, useSpadeConnectors } from "./spade-connector-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { LoadingRows } from "./spade-settings-loading.tsx";
import { CouldNotRead, Refusal } from "./spade-settings-rows.tsx";
import { isStandingRefusal } from "@/boot/person-standing.ts";

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * Settings › Spade › Apps, its first group (ADR 0131): the apps Spade is connected to, each with
 * its health (Working, Signed out), the account, the bots that use it, named from `names`,
 * and when a bot last used it; Reconnect when its sign-in ended, and Disconnect. Then Connect an
 * app.
 */
export function ConnectorSettings(props: { ready: boolean; names: ReadonlyMap<string, string> }) {
  const connectors = useSpadeConnectors(props.ready);
  const [adding, setAdding] = useState(false);
  // One catalogue: with the Marketplace on, its Apps, where each app connects in place; without
  // it, this catalogue dialog.
  const market = useBetaEnabled("marketplace") === true;
  const openMarket = useOpenMarket();
  return (
    <section aria-label="Connected apps" className={settingsGroup}>
      <SettingCard>
        {connectors.isPending ? (
          <LoadingRows label="Apps" rows={2} />
        ) : connectors.isError ? (
          <CouldNotRead
            what="Spade's apps"
            error={connectors.error}
            retry={() => void connectors.refetch()}
          />
        ) : (
          <>
            {connectors.data.connectors.map((connector) => (
              <ConnectorRow
                key={connector.id}
                connector={connector}
                names={props.names}
                // "Used 3 hours ago" as of when the list was read: no clock of its own.
                now={connectors.dataUpdatedAt}
              />
            ))}
            <SettingAddRow onClick={() => (market ? openMarket("apps") : setAdding(true))}>
              Connect an app
            </SettingAddRow>
          </>
        )}
      </SettingCard>
      {adding && connectors.data && (
        <AddConnectorDialog
          catalogue={connectors.data.catalogue}
          added={
            new Map(
              connectors.data.connectors.flatMap((each) =>
                each.catalogue ? [[each.catalogue, spadeConnectorLine(each)] as const] : [],
              ),
            )
          }
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}

/** The bots in `ids` by name, in Spade's order; ids not in the roster are left out. */
export function botNames(ids: readonly string[], names: ReadonlyMap<string, string>) {
  return ids.flatMap((id) => {
    const name = names.get(id);
    return name ? [name] : [];
  });
}

/**
 * One connected app: its state and account in one line, the bots that use it in the next. Its
 * action is the shared connect flow's (Reconnect, followed in place, a failure that says what
 * fixes it), or Use in another bot while it works; a device sign-in shows its code with Copy
 * code and Open. Disconnect is a quiet word at the end.
 */
function ConnectorRow(props: {
  connector: SpadeConnector;
  names: ReadonlyMap<string, string>;
  now: number;
}) {
  const { connector } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const refresh = () => cache.invalidateQueries({ queryKey: connectorsKey });
  const signedOut = connector.state === "needs_reconnect" || connector.state === "signing_in";
  const { device } = connector;
  const users = botNames(connector.bots, props.names);
  const copy = useCopy(() => toast.error({ title: "Couldn't copy the code" }));
  const connect = useAppConnect({
    app: {
      catalogue: connector.catalogue,
      name: connector.name,
      connector,
      ready: connector.signIn === "token" ? "key" : "sign_in",
    },
    size: "sm",
    onConnected: () => void refresh(),
  });
  // A device sign-in starts again in place: its new code shows in this row.
  const deviceAgain = async () => {
    setBusy(true);
    const outcome = await connectHere(() => reconnect(client, connector.id));
    setBusy(false);
    await refresh();
    if (outcome.kind !== "done")
      toast.error({ title: `Couldn't reconnect ${connector.name}`, description: outcome.message });
  };
  // A disconnect only the person may make shows its refusal in the row, with Confirm it's you.
  const [refused, setRefused] = useState<string>();
  const remove = async () => {
    setBusy(true);
    setRefused(undefined);
    try {
      await disconnect(client, connector.id);
      await refresh();
    } catch (error) {
      if (isStandingRefusal(fault(error))) setRefused(fault(error));
      else
        toast.error({ title: `Couldn't disconnect ${connector.name}`, description: fault(error) });
    } finally {
      setBusy(false);
    }
  };
  const state = [
    connector.device ? spadeConnectorLine(connector) : spadeConnectorHealth(connector),
    connector.account,
    spadeCloudLine(connector),
    connector.local && "On your own network",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <SettingRow
      title={connector.name}
      leading={<AppMark catalogue={connector.catalogue} name={connector.name} />}
      description={
        <>
          <span className="block">
            {refused ? (
              <Refusal onConfirmed={() => void remove()}>{refused}</Refusal>
            ) : (
              (connect.status ?? state)
            )}
          </span>
          <span className="block">
            {[
              users.length > 0 ? `Used by ${users.join(", ")}` : "No bot uses it",
              spadeLastUsedWords(connector.lastUsedMs, props.now),
            ].join(" · ")}
          </span>
        </>
      }
      density="compact"
    >
      <div className="flex items-center gap-1.5">
        {device?.state === "waiting" ? (
          <>
            <Button size="sm" onClick={() => copy.copy(device.code)}>
              {copy.copied ? "Copied" : "Copy code"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void openExternal(device.url).catch((error: unknown) =>
                  toast.error({
                    title: `Couldn't open ${connector.name}`,
                    description: fault(error),
                  }),
                )
              }
            >
              Open
            </Button>
          </>
        ) : device ? (
          <Button size="sm" disabled={busy} onClick={() => void deviceAgain()}>
            Try again
          </Button>
        ) : signedOut ? (
          connect.action
        ) : (
          <UseInAnotherBot connector={connector} size="sm" variant="ghost" />
        )}
        {connector.notice === "ace_signed_out" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void navigate({ to: "/settings/profile" })}
          >
            Sign in to ace
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Disconnect ${connector.name}`}
          disabled={busy || connect.busy}
          onClick={() => void remove()}
        >
          Disconnect
        </Button>
      </div>
    </SettingRow>
  );
}
