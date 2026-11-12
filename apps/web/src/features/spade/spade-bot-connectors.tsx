import type { SpadeConnectorAccess } from "@ace/ui-core/spade-chat";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { setAccess, useConnectorAccess, useSpadeConnectors } from "./spade-connector-api.ts";
import type { SpadeTarget } from "./spade-requests.ts";

/**
 * Which connected apps a bot may use (ADR 0131), as the edit form holds it: what Spade has, the
 * person's change, and saving that change. Spade may use every app unless narrowed; a new bot
 * none until turned on.
 */
export function useConnectorChoice(agent: string) {
  const stored = useConnectorAccess(agent);
  const connectors = useSpadeConnectors();
  const [draft, setDraft] = useState<SpadeConnectorAccess>();
  const current = draft ?? stored.data;
  const changed = draft !== undefined && stored.data !== undefined && !same(draft, stored.data);
  return {
    current,
    connectors: connectors.data?.connectors ?? [],
    loading: stored.isPending || connectors.isPending,
    problem: stored.error?.message ?? connectors.error?.message,
    changed,
    set: setDraft,
    save: async (client: SpadeTarget) => {
      if (changed && draft) await setAccess(client, agent, draft);
    },
  };
}

function same(a: SpadeConnectorAccess, b: SpadeConnectorAccess) {
  return (
    a.all === b.all &&
    a.connectors.length === b.connectors.length &&
    a.connectors.every((id) => b.connectors.includes(id))
  );
}

/** The switches: Every connected app (for Spade), then one per connected app. */
export function ConnectorChoice(props: {
  choice: ReturnType<typeof useConnectorChoice>;
  main: boolean;
}) {
  const { choice } = props;
  const allId = useId();
  if (choice.problem) return <p className="text-xs text-muted-foreground">{choice.problem}</p>;
  if (choice.loading || !choice.current) return null;
  const current = choice.current;
  if (choice.connectors.length === 0)
    return (
      <div className="flex items-center gap-2 text-ui text-muted-foreground">
        No apps connected.
        <Link to="/settings/spade" className={buttonVariants({ size: "sm", variant: "ghost" })}>
          Connect an app
        </Link>
      </div>
    );
  const ids = choice.connectors.map((each) => each.id);
  return (
    <ul className="flex flex-col gap-2">
      {props.main && (
        <SwitchRow
          id={allId}
          label="Every connected app"
          checked={current.all}
          onChange={(all) =>
            // Narrowing starts from everything, so nothing is lost by the switch alone.
            choice.set({ all, connectors: all ? [] : ids })
          }
        />
      )}
      {!current.all &&
        choice.connectors.map((connector) => (
          <ConnectorSwitch
            key={connector.id}
            name={connector.name}
            // Not signed in yet: nothing to give a bot until the sign-in finishes.
            disabled={connector.state === "signing_in"}
            checked={current.connectors.includes(connector.id)}
            onChange={(on) =>
              choice.set({
                all: false,
                connectors: on
                  ? [...current.connectors, connector.id]
                  : current.connectors.filter((id) => id !== connector.id),
              })
            }
          />
        ))}
    </ul>
  );
}

function ConnectorSwitch(props: {
  name: string;
  checked: boolean;
  disabled: boolean;
  onChange(on: boolean): void;
}) {
  const id = useId();
  return (
    <SwitchRow
      id={id}
      label={props.name}
      checked={props.checked}
      disabled={props.disabled}
      onChange={props.onChange}
    />
  );
}

function SwitchRow(props: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange(on: boolean): void;
}) {
  return (
    <li className="flex items-center justify-between gap-3">
      <label htmlFor={props.id} className="text-ui text-foreground">
        {props.label}
      </label>
      <Switch
        id={props.id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
      />
    </li>
  );
}
