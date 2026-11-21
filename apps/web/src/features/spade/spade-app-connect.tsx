import type { SpadeAppReady, SpadeConnector } from "@ace/ui-core/spade-chat";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { ConnectProgress } from "./spade-connect-progress.tsx";
import { connectProgress, useConnectApp } from "./use-connect-app.ts";

/*
 * Connecting one app, the same everywhere it's offered (the Marketplace's Apps and an app's page,
 * Settings › Apps, a bot's Apps): one button in words (Connect, Reconnect, Add a key), then
 * the sign-in followed in place in one line with Cancel, a failure that says what fixes it with
 * Try again, and the connection handed to `onConnected`. A key is typed inline and sent once.
 * The surface lays the two parts out: `action` where its button goes, `status` under its words.
 */

export interface AppToConnect {
  /** The catalogue entry it connects from; none for a server added by address. */
  catalogue: string | undefined;
  name: string;
  /** The person's connection to it already, to reconnect. */
  connector: SpadeConnector | undefined;
  ready: SpadeAppReady;
  keyUrl?: string | undefined;
}

export function useAppConnect(props: {
  app: AppToConnect;
  /** `lg` on a page, `sm` in a row. */
  size: "sm" | "lg";
  /** The page's one primary action; a row's is secondary. */
  primary?: boolean;
  onConnected?(connector: SpadeConnector): void;
}): { action: ReactNode; status: ReactNode; busy: boolean } {
  const { app } = props;
  const navigate = useNavigate();
  const field = useId();
  const flow = useConnectApp({
    name: app.name,
    onConnected: (connector) => props.onConnected?.(connector),
  });
  const [keyOpen, setKeyOpen] = useState(false);
  const [key, setKey] = useState("");
  const reconnecting = app.connector !== undefined;
  const byKey = reconnecting ? app.connector?.signIn === "token" : app.ready === "key";
  const progress = connectProgress(flow.phase, app.name);
  const failure = flow.phase.kind === "failed" ? flow.phase.message : undefined;
  const busy = progress !== undefined;
  const start = (token?: string) => {
    const typed = token?.trim();
    void flow.start(
      reconnecting && app.connector
        ? { reconnect: app.connector.id, ...(typed ? { token: typed } : {}) }
        : { catalogue: app.catalogue ?? app.name, ...(typed ? { token: typed } : {}) },
    );
  };
  const word = failure ? "Try again" : reconnecting ? "Reconnect" : byKey ? "Add a key" : "Connect";
  const variant = props.primary ? "primary" : "secondary";
  const needsAce = flow.phase.kind === "failed" && flow.phase.needsAce === true;
  const action: ReactNode =
    app.ready === "later" && !reconnecting ? null : busy ? null : needsAce ? (
      <Button
        size={props.size}
        variant={variant}
        onClick={() => void navigate({ to: "/settings/profile" })}
      >
        Sign in to ace
      </Button>
    ) : (
      <Button
        size={props.size}
        variant={variant}
        aria-label={`${word} ${app.name}`}
        aria-expanded={byKey ? keyOpen : undefined}
        onClick={() => (byKey ? setKeyOpen(!keyOpen) : start())}
      >
        {word}
      </Button>
    );
  const keyForm = byKey && keyOpen && !busy && (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!key.trim()) return;
        const typed = key;
        // The field empties before the request goes, so the key lives only in this call.
        setKey("");
        setKeyOpen(false);
        start(typed);
      }}
    >
      <label htmlFor={field} className="sr-only">{`Key for ${app.name}`}</label>
      <Input
        id={field}
        // Opened by the person's click, so the field they asked for takes the typing.
        autoFocus
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste the key"
        value={key}
        onChange={(event) => setKey(event.target.value)}
        className="w-64"
      />
      <Button size="sm" type="submit" disabled={!key.trim()}>
        Connect
      </Button>
      {app.keyUrl && (
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => void openExternal(app.keyUrl ?? "").catch(() => {})}
        >
          {`Make a key in ${app.name}`}
        </Button>
      )}
    </form>
  );
  const status: ReactNode = progress ? (
    <ConnectProgress phase={flow.phase} name={app.name} onCancel={flow.cancel} />
  ) : failure ? (
    <p role="alert" className="text-destructive">
      {failure}
    </p>
  ) : keyForm ? (
    keyForm
  ) : null;
  return { action, status, busy };
}
