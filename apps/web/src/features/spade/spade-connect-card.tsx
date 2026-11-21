import { spadeConnectAction, type SpadeConnectAsk } from "@ace/ui-core/spade-chat";
import { useId, useState } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { AppMark } from "@/components/ui/app-mark.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import {
  CardBody,
  CardFooter,
  CardPrimary,
  CardWord,
  NeedsYouLine,
  RaisedCard,
} from "./spade-card.tsx";
import { useSpadeConnectors } from "./spade-connector-api.ts";
import { ConnectProgress } from "./spade-connect-progress.tsx";
import { connectProgress, useConnectApp } from "./use-connect-app.ts";

/**
 * A card asking the person to connect an app (ADR 0131, amendment 1; docs/design/spade.md
 * "Raised card"): the app's mark and name, the bot's one-line reason, what the bot will be able to
 * do, and one action in words: Connect <App> (the sign-in opens in the browser and the card
 * follows it in one line), Add a key (its steps inline), Use <App> (connected already, for other
 * bots), or Reconnect <App>. Connecting is always the person's; the bot never sees the sign-in.
 *
 * Self-contained, so any flow that asks for an app can show it: it connects the app, then hands
 * the connector to `onConnected`, which gives it to the bot. An app connected meanwhile elsewhere
 * (Settings, another card) turns the action into Use <App>.
 */
export function ConnectAppCard(props: {
  ask: SpadeConnectAsk;
  /** The bot's reason, in its words. */
  why: string;
  botName: string;
  /** Gives the connected app to the bot (every bot with `everyone`); resolves with what went wrong, if anything. */
  onConnected(connector: string, everyone: boolean): Promise<string | undefined>;
  /** Later: answer when the person likes (ADR 0154). Left out where there is no later. */
  onLater?: (() => void) | undefined;
  /** Not now: the bot carries on without it. */
  onNotNow?: (() => void) | undefined;
  /** Its element's data attribute, so "for later" can reach it. */
  callId?: string;
}) {
  const { ask } = props;
  const field = useId();
  const everyoneId = useId();
  const [everyone, setEveryone] = useState(false);
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<string>();
  const [giving, setGiving] = useState(false);
  const listed = useSpadeConnectors();
  const connectors = listed.data?.connectors ?? [];
  // Connected meanwhile, here or elsewhere: nothing to sign in to, only to give.
  const usable = connectors.find(
    (each) =>
      (each.catalogue === ask.app || each.id === ask.app) &&
      each.state !== "needs_reconnect" &&
      each.state !== "signing_in",
  );
  const way = usable && ask.way !== "use" ? "use" : ask.way;
  const existing = connectors.find((each) => each.id === ask.connector);
  // A connector signed in with a key reconnects with a new one.
  const needsKey = way === "key" || (way === "reconnect" && existing?.signIn === "token");
  const give = async (connector: string) => {
    setGiving(true);
    setProblem(undefined);
    const said = await props.onConnected(connector, everyone);
    setGiving(false);
    if (said) setProblem(said);
  };
  const flow = useConnectApp({
    name: ask.name,
    onConnected: (connector) => void give(connector.id),
  });
  const progress = connectProgress(flow.phase, ask.name);
  const failure = flow.phase.kind === "failed" ? flow.phase.message : problem;
  const busy = giving || progress !== undefined;
  const act = () => {
    setProblem(undefined);
    if (way === "use") return void give(usable?.id ?? ask.connector ?? "");
    if (needsKey && !key.trim()) return setProblem("Paste the key first.");
    const token = needsKey ? key.trim() : undefined;
    setKey("");
    const target =
      way === "reconnect" && ask.connector
        ? { reconnect: ask.connector, ...(token ? { token } : {}) }
        : { catalogue: ask.app, ...(token ? { token } : {}) };
    void flow.start(target);
  };
  const action = spadeConnectAction({ ...ask, way: needsKey && way !== "key" ? "key" : way });
  return (
    <RaisedCard
      asks="question"
      role="group"
      aria-label={`${props.botName} asks to ${way === "reconnect" ? "reconnect" : "use"} ${ask.name}`}
      data-question={props.callId}
      tabIndex={-1}
    >
      <NeedsYouLine glyph="question">
        <div className="flex min-w-0 items-center gap-2.5">
          <AppMark catalogue={ask.app} name={ask.name} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-foreground">{ask.name}</span>
            <span className="truncate text-ui text-muted-foreground">
              {way === "reconnect"
                ? `Signed out, so ${props.botName} can't use it now`
                : `${props.botName} wants to use it`}
            </span>
          </div>
        </div>
      </NeedsYouLine>
      <CardBody>
        <SpadeBubbleText text={props.why} />
        {ask.can.length > 0 && (
          <p className="text-ui text-muted-foreground">
            {`${props.botName} will be able to ${sentenceOf(ask.can)}.`}
          </p>
        )}
        {needsKey && (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              act();
            }}
          >
            <ol className="list-decimal pl-5 text-ui text-muted-foreground">
              <li>
                {ask.keyUrl ? (
                  <button
                    type="button"
                    className="rounded-sm font-medium text-foreground focus-ring hover:underline"
                    onClick={() => void openExternal(ask.keyUrl ?? "").catch(() => {})}
                  >
                    {`Make a key in ${ask.name}`}
                  </button>
                ) : (
                  `Make a key in ${ask.name}'s settings`
                )}
              </li>
              <li>
                <label htmlFor={field}>
                  Paste it here. It goes to your keychain, not the chat.
                </label>
              </li>
            </ol>
            <Input
              id={field}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Key"
              value={key}
              disabled={busy}
              onChange={(event) => setKey(event.target.value)}
            />
          </form>
        )}
        {way !== "reconnect" && way !== "later" && (
          <div className="flex items-center gap-2 text-ui text-muted-foreground">
            <Checkbox
              id={everyoneId}
              checked={everyone}
              disabled={busy}
              onCheckedChange={(checked) => setEveryone(checked === true)}
            />
            <label htmlFor={everyoneId}>{`Let every bot use ${ask.name}`}</label>
          </div>
        )}
        {progress && (
          <ConnectProgress
            phase={flow.phase}
            name={ask.name}
            onCancel={flow.cancel}
            className="text-ui text-foreground"
          />
        )}
        {failure && (
          <p role="alert" className="text-xs leading-4 text-destructive">
            {failure}
          </p>
        )}
      </CardBody>
      <CardFooter
        start={
          <>
            {props.onLater && (
              <CardWord disabled={busy} onClick={props.onLater}>
                Later
              </CardWord>
            )}
            {props.onNotNow && (
              <CardWord disabled={busy} onClick={props.onNotNow}>
                Not now
              </CardWord>
            )}
          </>
        }
        end={
          action ? (
            <CardPrimary disabled={busy} onClick={act}>
              {giving ? "Connecting…" : failure && flow.phase.kind === "failed" ? "Try again" : action}
            </CardPrimary>
          ) : (
            <span className="text-ui text-muted-foreground">Not available yet</span>
          )
        }
      />
    </RaisedCard>
  );
}

/** "read issues and projects and comment on issues": the things a bot may do, as one clause. */
function sentenceOf(can: readonly string[]): string {
  const lower = can.map((line) => line.charAt(0).toLowerCase() + line.slice(1).replace(/\.$/, ""));
  if (lower.length < 2) return lower[0] ?? "";
  return `${lower.slice(0, -1).join(", ")} and ${lower.at(-1) ?? ""}`;
}
