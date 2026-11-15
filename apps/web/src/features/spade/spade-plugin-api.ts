import { parseSpadeBotPlugins, type SpadeBotPlugins } from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";

/*
 * A bot's plugins (ADR 0151, spade/docs/plugins.md): the person's plugins accepted in ace, and
 * which of them this bot may use.
 */

function sure(value: SpadeBotPlugins | undefined): SpadeBotPlugins {
  if (value === undefined) throw new Error("Spade's plugins didn't make sense.");
  return value;
}

export async function readBotPlugins(
  target: SpadeTarget,
  agent: string,
  options: { signal?: AbortSignal | undefined } = {},
) {
  const body = await spadeHttp(target, "GET", `/v1/agents/${segment(agent)}/plugins`, options);
  return sure(parseSpadeBotPlugins(body));
}

/** Lets the bot use exactly `plugins`. */
export async function setBotPlugins(target: SpadeTarget, agent: string, plugins: string[]) {
  const path = `/v1/agents/${segment(agent)}/plugins`;
  return sure(parseSpadeBotPlugins(await spadeHttp(target, "PUT", path, { body: { plugins } })));
}

export const pluginsKey = ["spade", "plugins"] as const;

export function useBotPlugins(agent: string) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  return useQuery({
    queryKey: [...pluginsKey, machine, agent],
    queryFn: ({ signal }) => readBotPlugins(client, agent, { signal }),
  });
}
