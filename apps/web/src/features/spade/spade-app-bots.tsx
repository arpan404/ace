import type { SpadeAgent, SpadeConnector } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Menu, MenuCheckboxItem, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { readAgents } from "./spade-api.ts";
import { connectorsKey, readAccess, setAccess } from "./spade-connector-api.ts";
import { SpadeFace } from "./spade-face.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { agentsKey } from "./use-spade-roster.ts";

/*
 * Which bots may use a connected app, from wherever the app is shown (its Marketplace page,
 * Settings › Apps): the bots that use it as their faces, and "Use in another bot", a menu of
 * every bot with a check on those allowed; picking one gives it the app or takes it away at once.
 * Spade itself, which uses every app until narrowed, shows checked and can't be unticked here.
 */

/** This machine's bots, as the list names them. */
export function useMachineBots(ready = true) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  return useQuery({
    queryKey: [...agentsKey, machine],
    queryFn: ({ signal }) => readAgents(client, { signal }),
    enabled: ready,
  });
}

/** The bots allowed to use `connector`, in the roster's order. */
export function botsUsing(connector: SpadeConnector, bots: readonly SpadeAgent[]) {
  const ids = new Set(connector.bots);
  return bots.filter((bot) => ids.has(bot.id));
}

/** The faces of the bots that use an app, overlapped, with their names for a screen reader. */
export function AppBotFaces(props: { bots: readonly SpadeAgent[]; size?: number }) {
  const size = props.size ?? 20;
  if (!props.bots.length) return null;
  return (
    <span
      className="inline-flex items-center"
      role="img"
      aria-label={props.bots.map((bot) => bot.name).join(", ")}
    >
      {props.bots.slice(0, 5).map((bot, at) => (
        <span
          key={bot.id}
          className="rounded-full bg-background p-px"
          style={{ marginLeft: at ? -size / 4 : 0 }}
        >
          <SpadeFace avatar={bot.avatar} size={size} />
        </span>
      ))}
    </span>
  );
}

export function UseInAnotherBot(props: {
  connector: SpadeConnector;
  size: "sm" | "lg";
  variant?: "secondary" | "ghost";
}) {
  const { connector } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const bots = useMachineBots().data ?? [];
  const [busy, setBusy] = useState<string>();
  const allowed = new Set(connector.bots);
  const toggle = async (bot: SpadeAgent) => {
    setBusy(bot.id);
    try {
      const access = await readAccess(client, bot.id);
      const has = access.connectors.includes(connector.id);
      await setAccess(client, bot.id, {
        all: access.all,
        connectors: has
          ? access.connectors.filter((id) => id !== connector.id)
          : [...access.connectors, connector.id],
      });
    } catch (error) {
      toast.error({
        title: `Couldn't change ${bot.name}'s apps`,
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setBusy(undefined);
      await cache.invalidateQueries({ queryKey: connectorsKey });
    }
  };
  return (
    <Menu>
      <MenuTrigger
        render={<Button size={props.size} variant={props.variant ?? "secondary"} />}
        disabled={!bots.length}
      >
        Use in another bot
      </MenuTrigger>
      <MenuContent align="end" className="max-h-[60vh] min-w-56 overflow-y-auto">
        {bots.map((bot) => (
          <MenuCheckboxItem
            key={bot.id}
            checked={allowed.has(bot.id)}
            disabled={busy !== undefined || (bot.kind === "main" && allowed.has(bot.id))}
            onCheckedChange={() => void toggle(bot)}
          >
            <span className="flex items-center gap-2">
              <SpadeFace avatar={bot.avatar} size={20} />
              {bot.name}
            </span>
          </MenuCheckboxItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
