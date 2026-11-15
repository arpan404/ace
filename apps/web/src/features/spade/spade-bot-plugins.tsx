import { spadePluginLine, type SpadePlugin } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Switch } from "@/components/ui/switch.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { pluginsKey, setBotPlugins, useBotPlugins } from "./spade-plugin-api.ts";
import { fault } from "./spade-profile-actions.ts";
import { ProfileEmpty, ProfileSection } from "./spade-profile-parts.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/**
 * Plugins (ADR 0151), a section of Details: one switch per plugin accepted in ace, saved as it
 * flips, with its line and what Spade doesn't use of it. A bot gets none until turned on; a
 * plugin turned off in ace is off for every bot. Without ace (or with a Spade before plugins)
 * the section isn't there.
 */
export function ProfilePlugins(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const stored = useBotPlugins(bot.id);
  const [problem, setProblem] = useState<string>();
  const page = stored.data;
  if (stored.isError || !page || page.plugins.length === 0) return null;
  const allowed = page.plugins.filter((each) => each.allowed).map((each) => each.name);
  const set = (name: string, on: boolean) => {
    setProblem(undefined);
    const next = on ? [...allowed, name] : allowed.filter((each) => each !== name);
    setBotPlugins(client, bot.id, next).then(
      () => cache.invalidateQueries({ queryKey: pluginsKey }),
      (error: unknown) => setProblem(fault(error)),
    );
  };
  return (
    <ProfileSection label="Plugins">
      {page.cli && (
        <ProfileEmpty>This bot runs on a subscription, so it gets only rules.</ProfileEmpty>
      )}
      {page.problem && <ProfileEmpty>{page.problem}</ProfileEmpty>}
      {page.plugins.map((plugin) => (
        <PluginRow
          key={plugin.name}
          plugin={plugin}
          checked={plugin.allowed}
          onChange={(on) => set(plugin.name, on)}
        />
      ))}
      {problem && (
        <p data-setting-slot="" role="alert" className="py-2 text-xs text-destructive">
          {`Couldn't change its plugins. ${problem}`}
        </p>
      )}
    </ProfileSection>
  );
}

function PluginRow(props: { plugin: SpadePlugin; checked: boolean; onChange(on: boolean): void }) {
  const id = useId();
  const { plugin } = props;
  return (
    <div data-setting-slot="" className="flex flex-col gap-1 py-2.5">
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-ui font-medium text-foreground">{plugin.name}</span>
          <span className="text-xs text-subtle-foreground">{spadePluginLine(plugin)}</span>
        </label>
        <Switch
          id={id}
          checked={props.checked}
          disabled={!plugin.enabledInAce}
          onCheckedChange={props.onChange}
        />
      </div>
      {plugin.remote.map((server) => (
        <p key={server.name} className="text-xs text-subtle-foreground">
          Server {server.name} is used as an app: add {server.url} in Apps.
        </p>
      ))}
      {plugin.notUsed.length > 0 && (
        <div className="text-xs text-subtle-foreground">
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
    </div>
  );
}
