import { spadeConnectorLine, type SpadeConnector } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingAddRow, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { AddConnectorDialog } from "./spade-add-connector.tsx";
import { connectHere, connectInBrowser } from "./spade-connect-flow.ts";
import { connectorsKey, disconnect, reconnect, useSpadeConnectors } from "./spade-connector-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * Settings › Spade › Connectors (ADR 0131): the apps Spade is connected to, each with its state
 * and what it needs (reconnect when its sign-in ended), and Connect an app.
 */
export function ConnectorSettings() {
  const connectors = useSpadeConnectors();
  const [adding, setAdding] = useState(false);
  if (connectors.isPending) return <ListSkeleton label="connectors" shape="row" rows={2} />;
  if (connectors.isError)
    return (
      <SettingSection label="Connectors">
        <SettingRow title="Couldn't read Spade's connectors" description={connectors.error.message}>
          <Button size="sm" onClick={() => void connectors.refetch()}>
            Try again
          </Button>
        </SettingRow>
      </SettingSection>
    );
  const { catalogue } = connectors.data;
  return (
    <>
      <SettingSection label="Connectors">
        {connectors.data.connectors.map((connector) => (
          <ConnectorRow key={connector.id} connector={connector} />
        ))}
        <SettingAddRow onClick={() => setAdding(true)}>Connect an app</SettingAddRow>
      </SettingSection>
      {adding && (
        <AddConnectorDialog
          catalogue={catalogue.filter(
            (entry) => !connectors.data.connectors.some((each) => each.id === entry.id),
          )}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}

/** One connected app: its state in words, Reconnect when its sign-in ended, and Disconnect. */
function ConnectorRow(props: { connector: SpadeConnector }) {
  const { connector } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const field = useId();
  const [busy, setBusy] = useState(false);
  // A token connector reconnects with a new token, typed here.
  const [token, setToken] = useState<string>();
  const refresh = () => cache.invalidateQueries({ queryKey: connectorsKey });
  const signedOut = connector.state === "needs_reconnect" || connector.state === "signing_in";
  const again = async () => {
    setBusy(true);
    const typed = token?.trim();
    setToken(undefined);
    const outcome = typed
      ? await connectHere(() => reconnect(client, connector.id, { token: typed }))
      : await connectInBrowser(() => reconnect(client, connector.id));
    setBusy(false);
    await refresh();
    if (outcome.kind !== "done")
      toast.error({ title: `Couldn't reconnect ${connector.name}`, description: outcome.message });
  };
  const remove = async () => {
    setBusy(true);
    try {
      await disconnect(client, connector.id);
      await refresh();
    } catch (error) {
      toast.error({ title: `Couldn't disconnect ${connector.name}`, description: fault(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow
      title={connector.name}
      description={spadeConnectorLine(connector)}
      htmlFor={token === undefined ? undefined : field}
      density="compact"
    >
      <div className="flex items-center gap-1.5">
        {token !== undefined ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (token.trim()) void again();
            }}
          >
            <Input
              id={field}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="w-52"
            />
            <Button size="sm" type="submit" disabled={busy || !token.trim()}>
              Connect
            </Button>
          </form>
        ) : (
          signedOut && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => (connector.signIn === "token" ? setToken("") : void again())}
            >
              Reconnect
            </Button>
          )
        )}
        <Button
          size="sm"
          variant="ghost"
          tone="danger"
          aria-label={`Disconnect ${connector.name}`}
          disabled={busy}
          onClick={() => void remove()}
        >
          Disconnect
        </Button>
      </div>
    </SettingRow>
  );
}
