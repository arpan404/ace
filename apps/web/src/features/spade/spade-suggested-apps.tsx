import type { SpadeCatalogueEntry, SpadeConnector } from "@ace/ui-core/spade-chat";
import { spadeAppCategories } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { AppMark } from "@/components/ui/app-mark.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { part } from "@/lib/suit-part.ts";
import {
  allowApp,
  connectorsKey,
  useAppsFit,
  useConnectorAccess,
  useSpadeConnectors,
} from "./spade-connector-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { ConnectProgress } from "./spade-connect-progress.tsx";
import { connectProgress, useConnectApp } from "./use-connect-app.ts";

/** The most apps suggested at once. */
const MOST = 4;

/**
 * Apps that fit a bot's task (ADR 0131, amendment 1), each with one click to connect it: the
 * catalogue's apps Spade matches to the task by its words, no model involved. An app connected
 * already for other bots offers Use, with no new sign-in; one that takes a key shows its steps in
 * place; one not available yet says so. Connecting gives the app to `botId`, when there is one,
 * then tells `onConnected` (which, before the bot exists, keeps it to give once it does).
 *
 * Self-contained, so a bot's settings and the new-bot flow can both show it: give it the task,
 * and the bot once there is one. Shows nothing when no app fits or every fitting app is the bot's.
 */
export function SuggestedApps(props: {
  task: string;
  botId?: string | undefined;
  onConnected?: ((connector: SpadeConnector) => void) | undefined;
  /** Its heading; "Apps that fit" unless given. */
  title?: string;
}) {
  const fit = useAppsFit(props.task);
  const listed = useSpadeConnectors();
  const access = useConnectorAccess(props.botId ?? "");
  const catalogue = listed.data?.catalogue ?? [];
  const connectors = listed.data?.connectors ?? [];
  const hasIt = (connector: SpadeConnector) =>
    props.botId !== undefined &&
    access.data !== undefined &&
    (access.data.all || access.data.connectors.includes(connector.id));
  const shown = (fit.data ?? [])
    .flatMap((id) => {
      const entry = catalogue.find((each) => each.id === id);
      return entry ? [entry] : [];
    })
    .filter((entry) => {
      // Already the bot's: nothing to suggest.
      return !connectors.some((each) => each.catalogue === entry.id && hasIt(each));
    })
    // Apps connected already lead: one click and no sign-in. Otherwise Spade's order.
    .toSorted(
      (a, b) =>
        Number(connectors.some((each) => each.catalogue === b.id)) -
        Number(connectors.some((each) => each.catalogue === a.id)),
    )
    .slice(0, MOST);
  if (shown.length === 0) return null;
  return (
    <section aria-label={props.title ?? "Apps that fit"} className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-subtle-foreground">
        {props.title ?? "Apps that fit"}
      </h3>
      <ul className="flex flex-col">
        {shown.map((entry) => (
          <SuggestedApp
            key={entry.id}
            entry={entry}
            connected={connectors.find(
              (each) =>
                each.catalogue === entry.id &&
                each.state !== "needs_reconnect" &&
                each.state !== "signing_in",
            )}
            botId={props.botId}
            onConnected={props.onConnected}
          />
        ))}
      </ul>
    </section>
  );
}

function SuggestedApp(props: {
  entry: SpadeCatalogueEntry;
  /** The person's connector for it, when it is connected already. */
  connected: SpadeConnector | undefined;
  botId: string | undefined;
  onConnected: ((connector: SpadeConnector) => void) | undefined;
}) {
  const { entry } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const field = useId();
  const [key, setKey] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const give = async (connector: SpadeConnector) => {
    setProblem(undefined);
    try {
      if (props.botId) await allowApp(client, props.botId, connector.id);
      await cache.invalidateQueries({ queryKey: connectorsKey });
      props.onConnected?.(connector);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Try again.");
    }
  };
  const flow = useConnectApp({ name: entry.name, onConnected: (c) => void give(c) });
  const progress = connectProgress(flow.phase, entry.name);
  const failure = flow.phase.kind === "failed" ? flow.phase.message : problem;
  const busy = progress !== undefined;
  const category = spadeAppCategories.find((each) => each.id === entry.category)?.label;
  const line = props.connected
    ? "Connected for your other bots"
    : entry.ready === "later"
      ? "Not available yet"
      : entry.ready === "key"
        ? "Takes a key you make in the app"
        : category;
  return (
    <li {...part("list-row", undefined, "suggested-app")} className="flex flex-col gap-1.5 py-2">
      <div className="flex min-h-9 items-center gap-3">
        <AppMark catalogue={entry.id} name={entry.name} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui font-medium text-foreground">{entry.name}</span>
          {line && <span className="truncate text-xs text-subtle-foreground">{line}</span>}
        </div>
        {props.connected ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Use ${entry.name}`}
            onClick={() => props.connected && void give(props.connected)}
          >
            Use
          </Button>
        ) : entry.ready === "sign_in" ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Connect ${entry.name}`}
            disabled={busy}
            onClick={() => void flow.start({ catalogue: entry.id })}
          >
            Connect
          </Button>
        ) : entry.ready === "key" && key === undefined ? (
          <Button size="sm" variant="ghost" onClick={() => setKey("")}>
            Add a key
          </Button>
        ) : null}
      </div>
      {key !== undefined && !props.connected && (
        <form
          className="flex flex-col gap-1.5 pl-11"
          onSubmit={(event) => {
            event.preventDefault();
            if (!key.trim()) return;
            const token = key.trim();
            setKey(undefined);
            void flow.start({ catalogue: entry.id, token });
          }}
        >
          <label htmlFor={field} className="text-xs text-muted-foreground">
            {entry.keyUrl ? (
              <>
                <button
                  type="button"
                  className="rounded-sm font-medium text-foreground focus-ring hover:underline"
                  onClick={() => void openExternal(entry.keyUrl ?? "").catch(() => {})}
                >
                  {`Make a key in ${entry.name}`}
                </button>
                {", then paste it here."}
              </>
            ) : (
              `Make a key in ${entry.name}'s settings, then paste it here.`
            )}
          </label>
          <div className="flex items-center gap-1.5">
            <Input
              id={field}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <Button size="sm" type="submit" disabled={!key.trim()}>
              Connect
            </Button>
          </div>
        </form>
      )}
      <ConnectProgress
        phase={flow.phase}
        name={entry.name}
        onCancel={flow.cancel}
        className="pl-11 text-xs text-foreground"
      />
      {failure && (
        <p role="alert" className="pl-11 text-xs text-destructive">
          {failure}
        </p>
      )}
    </li>
  );
}
