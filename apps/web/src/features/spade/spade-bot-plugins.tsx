import { spadePluginLine, type SpadePlugin } from "@ace/ui-core/spade-chat";
import { useId, useState } from "react";
import { Switch } from "@/components/ui/switch.tsx";
import { setBotPlugins, useBotPlugins } from "./spade-plugin-api.ts";
import type { SpadeTarget } from "./spade-requests.ts";

/**
 * Which of the person's plugins a bot may use (ADR 0151), as the edit form holds it: what Spade
 * has, the person's change, and saving it. A bot gets none until turned on; a plugin turned off
 * in ace is off for every bot.
 */
export function usePluginChoice(agent: string) {
  const stored = useBotPlugins(agent);
  const [draft, setDraft] = useState<string[]>();
  const saved = (stored.data?.plugins ?? [])
    .filter((each) => each.allowed)
    .map((each) => each.name);
  const current = draft ?? saved;
  const changed =
    draft !== undefined &&
    (draft.length !== saved.length || draft.some((name) => !saved.includes(name)));
  return {
    page: stored.data,
    current,
    loading: stored.isPending,
    // Without ace (or with a Spade that predates plugins) there is nothing to choose.
    problem: stored.error ? undefined : stored.data?.problem,
    unavailable: stored.isError,
    changed,
    set: setDraft,
    save: async (client: SpadeTarget) => {
      if (changed && draft) await setBotPlugins(client, agent, draft);
    },
  };
}

/** One switch per accepted plugin, its line, and what Spade doesn't use of it. */
export function PluginChoice(props: { choice: ReturnType<typeof usePluginChoice> }) {
  const { choice } = props;
  if (choice.unavailable)
    return <p className="text-xs text-muted-foreground">Plugins come from ace.</p>;
  if (choice.loading || !choice.page) return null;
  const { plugins, cli } = choice.page;
  if (plugins.length === 0)
    return <p className="text-ui text-muted-foreground">No plugins accepted in ace.</p>;
  return (
    <div className="flex flex-col gap-2">
      {cli && (
        <p className="text-xs text-muted-foreground">
          This bot runs on a subscription, so it gets only rules.
        </p>
      )}
      {choice.problem && <p className="text-xs text-muted-foreground">{choice.problem}</p>}
      <ul className="flex flex-col gap-3">
        {plugins.map((plugin) => (
          <PluginRow
            key={plugin.name}
            plugin={plugin}
            checked={choice.current.includes(plugin.name)}
            onChange={(on) =>
              choice.set(
                on
                  ? [...choice.current, plugin.name]
                  : choice.current.filter((name) => name !== plugin.name),
              )
            }
          />
        ))}
      </ul>
    </div>
  );
}

function PluginRow(props: { plugin: SpadePlugin; checked: boolean; onChange(on: boolean): void }) {
  const id = useId();
  const { plugin } = props;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="flex min-w-0 flex-col">
          <span className="text-ui text-foreground">{plugin.name}</span>
          <span className="text-xs text-muted-foreground">{spadePluginLine(plugin)}</span>
        </label>
        <Switch
          id={id}
          checked={props.checked}
          disabled={!plugin.enabledInAce}
          onCheckedChange={props.onChange}
        />
      </div>
      {plugin.remote.map((server) => (
        <p key={server.name} className="text-xs text-muted-foreground">
          Server {server.name} is used as an app: add {server.url} in Apps.
        </p>
      ))}
      {plugin.notUsed.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <p>Not used by Spade:</p>
          <ul className="flex flex-col">
            {plugin.notUsed.map((entry) => (
              <li key={`${entry.what}-${entry.reason}`}>
                {entry.what}: {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
