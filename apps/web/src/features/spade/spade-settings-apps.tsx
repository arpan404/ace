import type { SpadeAgent, SpadePlugin } from "@ace/ui-core/spade-chat";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { readAgents } from "./spade-api.ts";
import { botNames, ConnectorSettings } from "./spade-connector-settings.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { pluginsKey, readBotPlugins } from "./spade-plugin-api.ts";
import { fault, Refusal, SpadeNotRunning, useSpadeRunning } from "./spade-settings-rows.tsx";
import { addSkillToAce, readSkillStore, type SpadeStoredSkill } from "./spade-skills-api.ts";
import { agentsKey } from "./use-spade-roster.ts";

const storeKey = ["spade", "skill-store"] as const;

/**
 * Settings › Spade › Apps: the apps Spade is connected to, then the plugins and skills its bots
 * use, each with the bots that use it. Which bots use an app or a skill shows once Spade says;
 * a plugin's, from each bot's own plugin choice.
 */
export function SpadeAppsSettings() {
  const { line, reading } = useSpadeRunning();
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  const agents = useQuery({
    // The roster's own entry for this machine, so the names are the list's.
    queryKey: [...agentsKey, machine],
    queryFn: ({ signal }) => readAgents(client, { signal }),
    enabled: line.ready,
  });
  if (!line.ready && !reading)
    return <SpadeNotRunning sentence={line.sentence} canTurnOn={line.canTurnOn} />;
  const bots = agents.data ?? [];
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  return (
    <>
      <ConnectorSettings ready={line.ready} names={names} />
      {line.ready && <PluginSection bots={bots} />}
      {line.ready && <SkillSection names={names} />}
    </>
  );
}

/**
 * The person's plugins accepted in ace, each with the bots allowed to use it. Spade answers per
 * bot, so each bot's choice is read; nothing shows until one answers, or when there are none.
 */
function PluginSection(props: { bots: readonly SpadeAgent[] }) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  const pages = useQueries({
    queries: props.bots.map((bot) => ({
      queryKey: [...pluginsKey, machine, bot.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => readBotPlugins(client, bot.id, { signal }),
      retry: false,
    })),
  });
  const plugins = new Map<string, { plugin: SpadePlugin; users: string[] }>();
  pages.forEach((page, at) => {
    const bot = props.bots[at];
    for (const plugin of page.data?.plugins ?? []) {
      const entry = plugins.get(plugin.name) ?? { plugin, users: [] };
      if (plugin.allowed && bot) entry.users.push(bot.name);
      plugins.set(plugin.name, entry);
    }
  });
  if (plugins.size === 0) return null;
  return (
    <SettingSection label="Plugins" anchor="plugins">
      {[...plugins.values()].map(({ plugin, users }) => (
        <SettingRow
          key={plugin.name}
          title={plugin.name}
          description={
            !plugin.enabledInAce
              ? "Turned off in ace"
              : users.length
                ? users.join(", ")
                : "No bot uses it"
          }
          density="compact"
        />
      ))}
    </SettingSection>
  );
}

/**
 * Skills the bots use or wrote, each with those bots (once Spade says), and Add to ace's library
 * for one written in Spade while ace is running. Shows nothing when there are none.
 */
function SkillSection(props: { names: ReadonlyMap<string, string> }) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  const store = useQuery({
    queryKey: [...storeKey, machine],
    queryFn: ({ signal }) => readSkillStore(client, { signal }),
  });
  const shown =
    store.data?.skills.filter(
      (skill) =>
        skill.origin === "spade" ||
        Boolean(skill.usedBy?.length) ||
        Boolean(skill.writtenBy?.length),
    ) ?? [];
  if (!store.data || shown.length === 0) return null;
  const { ace } = store.data;
  return (
    <SettingSection label="Skills" anchor="skills">
      {shown.map((skill) => (
        <SkillRow key={skill.id} skill={skill} ace={ace} names={props.names} />
      ))}
    </SettingSection>
  );
}

/** Who uses a skill, and who wrote it when that isn't the same bots. */
function skillLine(skill: SpadeStoredSkill, names: ReadonlyMap<string, string>): string {
  const users = botNames(skill.usedBy, names);
  const writers = botNames(skill.writtenBy, names).filter((name) => !users.includes(name));
  return [
    users.length ? users.join(", ") : undefined,
    writers.length ? `Written by ${writers.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function SkillRow(props: {
  skill: SpadeStoredSkill;
  ace: boolean;
  names: ReadonlyMap<string, string>;
}) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const add = async () => {
    setAdding(true);
    setRefusal(undefined);
    try {
      await addSkillToAce(client, props.skill.id);
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setAdding(false);
      await cache.invalidateQueries({ queryKey: storeKey });
    }
  };
  const line = skillLine(props.skill, props.names);
  return (
    <SettingRow
      title={props.skill.name}
      description={refusal ? <Refusal>{refusal}</Refusal> : line || props.skill.description}
      density="compact"
    >
      {props.ace && props.skill.origin === "spade" && (
        <Button size="sm" disabled={adding} onClick={() => void add()}>
          Add to ace's library
        </Button>
      )}
    </SettingRow>
  );
}
