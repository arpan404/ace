import type { SpadeCatalogueEntry } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { connectHere, connectInBrowser, type ConnectOutcome } from "./spade-connect-flow.ts";
import { connect, connectorsKey, type SpadeConnectDraft } from "./spade-connector-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/** How the person is connecting one server: signing in, a token, or their own client ID. */
type Way = "sign_in" | "token" | "client";

/**
 * Connect an app: the catalogue of apps' own servers, each with the ways it takes (sign in, a
 * token, a client ID registered with its maker), and any other server by its address. Signing
 * in opens the app's page in the person's browser; the dialog closes and the app's row in
 * Settings follows the sign-in.
 */
export function AddConnectorDialog(props: {
  catalogue: readonly SpadeCatalogueEntry[];
  onClose(): void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Connect an app</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <ul className="flex flex-col divide-y divide-border">
            {props.catalogue.map((entry) => (
              <li key={entry.id} className="py-2.5 first:pt-0">
                <ServerChoice
                  name={entry.name}
                  notes={entry.notes}
                  ways={waysOf(entry)}
                  draft={{ catalogue: entry.id }}
                  onDone={props.onClose}
                />
              </li>
            ))}
          </ul>
          <ByAddress onDone={props.onClose} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** The ways a catalogue entry takes, the one-click sign-in first. */
function waysOf(entry: SpadeCatalogueEntry): Way[] {
  return entry.signIn.map((kind) =>
    kind === "oauth" ? "sign_in" : kind === "token" ? "token" : "client",
  );
}

const firstLabel: Record<Way, string> = {
  sign_in: "Sign in",
  token: "Use a token",
  client: "Use a client ID",
};

/** One server: its name and notes, a button per way in, and the fields the chosen way needs. */
function ServerChoice(props: {
  name: string;
  notes?: string;
  ways: Way[];
  draft: SpadeConnectDraft;
  onDone(): void;
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
    setBusy(true);
    setProblem(undefined);
    setNeedsAce(false);
    await finish(await connectInBrowser(() => connect(client, { ...props.draft, ...extra })));
  };
  const useToken = async () => {
    const typed = token.trim();
    // The field empties before the request goes, so the token lives only in this call.
    setToken("");
    setBusy(true);
    setProblem(undefined);
    await finish(await connectHere(() => connect(client, { ...props.draft, token: typed })));
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-ui font-medium text-foreground">{props.name}</span>
          {props.notes && <span className="text-xs text-muted-foreground">{props.notes}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {props.ways.map((way, index) => (
            <Button
              key={way}
              size="sm"
              variant={index === 0 ? "secondary" : "ghost"}
              aria-label={`${firstLabel[way]} for ${props.name}`}
              disabled={busy}
              onClick={() => (way === "sign_in" ? void signIn() : setOpen(way))}
            >
              {firstLabel[way]}
            </Button>
          ))}
        </div>
      </div>
      {open === "token" && (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim()) void useToken();
          }}
        >
          <label htmlFor={ids.token} className="sr-only">{`Token for ${props.name}`}</label>
          <Input
            id={ids.token}
            // Opened by the person's click, so the field they asked for takes the typing.
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={busy}
            className="w-64"
          />
          <Button size="sm" type="submit" disabled={busy || !token.trim()}>
            Connect
          </Button>
        </form>
      )}
      {open === "client" && (
        <form
          className="flex flex-wrap items-center gap-1.5"
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
        <div role="alert" className="flex items-center justify-between gap-3">
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
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * Any other remote MCP server, by its address. A server on the person's own machine or network
 * is marked so here, explicitly: only then may its sign-in reach local addresses.
 */
function ByAddress(props: { onDone(): void }) {
  const field = useId();
  const localId = useId();
  const [address, setAddress] = useState("");
  const [local, setLocal] = useState(false);
  const typed = address.trim();
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <label htmlFor={field} className="w-fit text-ui font-medium">
        Another server
      </label>
      <Input
        id={field}
        type="url"
        spellCheck={false}
        placeholder="https://example.com/mcp"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
      />
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={localId} className="text-ui text-foreground">
          On my own machine or network
        </label>
        <Switch id={localId} checked={local} onCheckedChange={setLocal} />
      </div>
      {/^https?:\/\/\S+/i.test(typed) && (
        <ServerChoice
          name={hostOf(typed)}
          ways={["sign_in", "token"]}
          draft={{ url: typed, ...(local ? { local: true } : {}) }}
          onDone={props.onDone}
        />
      )}
    </div>
  );
}

function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}
