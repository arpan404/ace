import type { SpadeAppReady, SpadeCatalogueEntry } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { AppMark } from "@/components/ui/app-mark.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { connectHere, connectInBrowser, type ConnectOutcome } from "./spade-connect-flow.ts";
import { connect, connectorsKey, type SpadeConnectDraft } from "./spade-connector-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/** How the person is connecting one server: signing in, a key, or their own client ID. */
export type Way = "sign_in" | "token" | "client";

/** The ways a catalogue entry takes now: Sign in only when it would work on this build. */
export function waysOf(entry: SpadeCatalogueEntry): Way[] {
  const ways = entry.signIn.map((kind): Way =>
    kind === "oauth" ? "sign_in" : kind === "token" ? "token" : "client",
  );
  return entry.ready === "sign_in" ? ways : ways.filter((way) => way !== "sign_in");
}

const wayLabel: Record<Way, string> = {
  sign_in: "Sign in",
  token: "Use a key",
  client: "Use your own app",
};

/** The one quiet sentence under an app that can't sign in with a click on this build. */
export function readyLine(name: string, ready: SpadeAppReady): string | undefined {
  if (ready === "key") return `Needs a key from ${name}.`;
  if (ready === "later") return "Coming soon.";
  return undefined;
}

/**
 * One app to connect: its mark and name, one quiet line (what it's for, that it needs a key, or
 * that it's coming), and a text button per way in. Choosing a key or the person's own app opens
 * its fields under the row, with the app's own steps and where to make a key.
 */
export function ServerChoice(props: {
  name: string;
  /** Its catalogue entry, for its mark; none for a server added by address. */
  catalogue?: string | undefined;
  notes?: string | undefined;
  keyUrl?: string | undefined;
  ready: SpadeAppReady;
  ways: Way[];
  /** Already added: its state in words, which the row says instead of offering a way in. */
  added?: string | undefined;
  draft: SpadeConnectDraft;
  onDone(): void;
  /** The person started connecting it. */
  onStart?(): void;
}) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const ids = { token: useId(), clientId: useId(), secret: useId() };
  const [open, setOpen] = useState<Way>();
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  // Spade Cloud signs this app in with the machine's ace account, which it isn't signed in to.
  const [needsAce, setNeedsAce] = useState(false);
  const navigate = useNavigate();
  const finish = async (outcome: ConnectOutcome) => {
    setBusy(false);
    await cache.invalidateQueries({ queryKey: connectorsKey });
    if (outcome.kind === "done") return props.onDone();
    if (outcome.kind === "needs_ace_account") {
      setNeedsAce(true);
      return setProblem(undefined);
    }
    // The server takes no automatic registration: offer the person's own client ID.
    if (outcome.kind === "needs_client") setOpen("client");
    setProblem(outcome.message);
  };
  const signIn = async (extra: SpadeConnectDraft = {}) => {
    props.onStart?.();
    setBusy(true);
    setProblem(undefined);
    setNeedsAce(false);
    await finish(await connectInBrowser(() => connect(client, { ...props.draft, ...extra })));
  };
  const useToken = async () => {
    props.onStart?.();
    const typed = token.trim();
    // The field empties before the request goes, so the token lives only in this call.
    setToken("");
    setBusy(true);
    setProblem(undefined);
    await finish(await connectHere(() => connect(client, { ...props.draft, token: typed })));
  };
  const line = props.added ?? readyLine(props.name, props.ready) ?? props.notes;
  // The app's own words come with the fields they explain.
  const steps = open && props.notes && props.notes !== line ? props.notes : undefined;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <AppMark catalogue={props.catalogue} name={props.name} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui font-medium text-foreground">{props.name}</span>
          {line && (
            <span className="line-clamp-2 text-xs text-muted-foreground" title={props.notes}>
              {line}
            </span>
          )}
        </div>
        {props.added === undefined && (
          <div className="flex shrink-0 items-center gap-1.5">
            {props.ways.map((way, index) => (
              <Button
                key={way}
                size="sm"
                variant={index === 0 && props.ready !== "later" ? "secondary" : "ghost"}
                aria-label={`${wayLabel[way]} for ${props.name}`}
                aria-expanded={way === "sign_in" ? undefined : open === way}
                disabled={busy}
                onClick={() =>
                  way === "sign_in" ? void signIn() : setOpen(open === way ? undefined : way)
                }
              >
                {wayLabel[way]}
              </Button>
            ))}
          </div>
        )}
      </div>
      {steps && <p className="pl-10 text-xs text-muted-foreground">{steps}</p>}
      {open === "token" && (
        <form
          className="flex flex-wrap items-center gap-1.5 pl-10"
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim()) void useToken();
          }}
        >
          <label htmlFor={ids.token} className="sr-only">{`Key for ${props.name}`}</label>
          <Input
            id={ids.token}
            // Opened by the person's click, so the field they asked for takes the typing.
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste key"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={busy}
            className="w-64"
          />
          <Button size="sm" type="submit" disabled={busy || !token.trim()}>
            Connect
          </Button>
          {props.keyUrl && (
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() =>
                void openExternal(props.keyUrl ?? "").catch((error: unknown) =>
                  setProblem(error instanceof Error ? error.message : "Couldn't open it."),
                )
              }
            >
              {`Get a key from ${props.name}`}
            </Button>
          )}
        </form>
      )}
      {open === "client" && (
        <form
          className="flex flex-wrap items-center gap-1.5 pl-10"
          onSubmit={(event) => {
            event.preventDefault();
            if (!clientId.trim()) return;
            const extra = {
              client_id: clientId.trim(),
              ...(secret.trim() ? { client_secret: secret.trim() } : {}),
            };
            setSecret("");
            void signIn(extra);
          }}
        >
          <label htmlFor={ids.clientId} className="sr-only">{`Client ID for ${props.name}`}</label>
          <Input
            id={ids.clientId}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="Client ID"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            disabled={busy}
            className="w-48"
          />
          <label
            htmlFor={ids.secret}
            className="sr-only"
          >{`Client secret for ${props.name}`}</label>
          <Input
            id={ids.secret}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Client secret, if any"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            disabled={busy}
            className="w-48"
          />
          <Button size="sm" type="submit" disabled={busy || !clientId.trim()}>
            Sign in
          </Button>
        </form>
      )}
      {needsAce && (
        <div role="alert" className="flex items-center justify-between gap-3 pl-10">
          <p className="text-xs text-muted-foreground">
            {`Sign in to your ace account on this machine to connect ${props.name} through Spade Cloud.`}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              props.onDone();
              void navigate({ to: "/settings/profile" });
            }}
          >
            Sign in to ace
          </Button>
        </div>
      )}
      {problem && (
        <p role="alert" className="pl-10 text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
