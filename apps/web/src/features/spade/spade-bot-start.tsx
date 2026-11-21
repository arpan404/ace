import type { ClientApi } from "@ace/client";
import {
  spadeAgentTaskMax,
  spadePersonalityBody,
  spadeQuietPersonality,
  type SpadePersonality,
  spadeFirstUsableModel,
  spadeFreeName,
  type SpadeAgent,
  type SpadeTemplate,
} from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { BotFace } from "@/components/bot-face.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Screen } from "@/features/shell/index.ts";
import { readingColumn } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { createAgent } from "./spade-api.ts";
import type { SpadeMessage } from "./spade-attachments.ts";
import { SpadeComposer } from "./spade-composer.tsx";
import { allowApp } from "./spade-connector-api.ts";
import { SuggestedApps } from "./spade-suggested-apps.tsx";
import { SpadeMachineScope, useSpadeClient } from "./spade-machine.tsx";
import { ConversationSkeleton, PageScroller, useSpadeLine } from "./spade-screen-parts.tsx";
import { RunsWithRows, StartFrom, TemplateRoutines } from "./spade-new-bot-parts.tsx";
import { SettingCard } from "@/components/setting-row.tsx";
import { PersonalityRows } from "./spade-profile-personality.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { importAgent, readTemplates } from "./spade-teams-api.ts";
import { useSpadeModels } from "./use-spade-models.ts";
import { agentsKey, useSpadeRoster, type SpadeHost } from "./use-spade-roster.ts";

/*
 * Two ways to start a bot besides a blank form (ADR 0132): from one of the templates Spade ships,
 * or from a bot file another machine exported.
 */

/**
 * The templates of the chosen machine's Spade, each its face, name and one line on what it does.
 * Picking one fills the form; picking it again lets it go.
 */
export function TemplateChoice(props: {
  client: ClientApi | undefined;
  machineKey: string;
  value: string | undefined;
  onChange(template: SpadeTemplate | undefined): void;
}) {
  const client = props.client;
  const templates = useQuery({
    queryKey: ["spade", "templates", props.machineKey],
    queryFn: ({ signal }) =>
      client ? readTemplates(client, { signal }) : Promise.reject(new Error("offline")),
    enabled: client !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (templates.isError)
    return <p className="text-xs text-muted-foreground">Templates couldn't be read.</p>;
  if (!templates.data) return null;
  if (templates.data.length === 0)
    return <p className="text-xs text-muted-foreground">This machine has no templates.</p>;
  return (
    <ul aria-label="Templates" className="flex max-h-44 flex-col overflow-y-auto">
      {templates.data.map((template) => {
        const chosen = props.value === template.id;
        return (
          <li key={template.id}>
            <button
              type="button"
              aria-pressed={chosen}
              onClick={() => props.onChange(chosen ? undefined : template)}
              className={cn(
                "flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset",
                chosen && "bg-active",
              )}
            >
              <BotFace face={template.face} size={24} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-ui text-foreground">{template.name}</span>
                {template.blurb && (
                  <span className="truncate text-xs text-muted-foreground">{template.blurb}</span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The person's IANA time zone, for a template's routines; undefined when the browser won't say. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The largest bot file Import reads: 6 MiB, room for a face image and the bot's settings. */
export const botFileMax = 6 * 1024 * 1024;

/**
 * Import bot: picks a `.json` bot file and sends it to the chosen machine's Spade. What that
 * machine left out comes back as lines the dialog shows before opening the new bot, on the
 * machine it was sent to. A file over `botFileMax` isn't read.
 */
export function ImportBot(props: {
  host: SpadeHost | undefined;
  onImported(agent: SpadeAgent, leftOut: readonly string[], host: SpadeHost): void;
  onProblem(problem: string | undefined): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const take = async (file: File | undefined) => {
    // The machine it goes to, as chosen now: the bot opens there even if the choice moves.
    const host = props.host;
    const client = host?.machine.client;
    if (!file || !host || !client) return;
    if (file.size > botFileMax) {
      props.onProblem("That file is too big for a bot file (6 MB at most).");
      if (input.current) input.current.value = "";
      return;
    }
    setImporting(true);
    props.onProblem(undefined);
    try {
      const answer = await importAgent(client, await file.text());
      props.onImported(answer.agent, answer.leftOut, host);
    } catch (error) {
      props.onProblem(error instanceof Error ? error.message : "Try again.");
    } finally {
      setImporting(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        aria-label="Bot file"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => void take(event.target.files?.[0])}
      />
      <Button
        variant="ghost"
        disabled={importing || !props.host?.machine.client}
        onClick={() => input.current?.click()}
        className="mr-auto"
      >
        {importing ? "Importing…" : "Import bot"}
      </Button>
    </>
  );
}

/**
 * `/spade/new` (docs/design/spade.md §5): a new bot starts from one message. The page asks "What
 * should this bot do?" over the composer; what the person sends is the bot's task and its first
 * message, in one call, and the bot's conversation opens on it. There the bot names itself and
 * picks its face (both changed in place with a click), says the job back, asks only what it must,
 * and starts. Above it, at the page's top: where it starts from (your own, or a template's face,
 * one press each), then its model, machine, routines and personality, none of them required.
 * Import is in the list's + only.
 */
export function NewBotStart(props: { template?: string | undefined } = {}) {
  const line = useSpadeLine();
  const roster = useSpadeRoster(line.ready);
  // The machine the person chose, kept while it is out of reach: never another one silently.
  const [chosen, setChosen] = useState<{ key: string; name: string }>();
  const host =
    roster.hosts.find((candidate) => candidate.spade.key === (chosen?.key ?? "primary")) ??
    (chosen ? undefined : roster.hosts[0]);
  if (!host)
    return (
      <Screen page="spade" title="">
        <h1 className="sr-only">New bot</h1>
        <div className={`${readingColumn} pt-6`}>
          {!line.ready ? (
            <SpadeStateStrip line={line} className="flex items-center gap-2 px-1 text-ui" />
          ) : roster.loading ? (
            <ConversationSkeleton />
          ) : (
            <p className="text-ui text-muted-foreground">
              {chosen
                ? `${chosen.name} isn't reachable right now.`
                : "Spade isn't reachable right now."}
            </p>
          )}
        </div>
      </Screen>
    );
  return (
    <SpadeMachineScope
      machine={host.machine}
      unavailable={
        <Screen page="spade" title="">
          <p className={`${readingColumn} pt-6 text-ui text-muted-foreground`}>
            {`${host.machine.name} is offline.`}
          </p>
        </Screen>
      }
    >
      <NewBotConversation
        // A template picked from the list while this page is open starts it over from that one.
        key={props.template ?? ""}
        startFrom={props.template}
        host={host}
        hosts={roster.hosts}
        names={roster.bots.map((bot) => bot.name)}
        blocked={line.ready ? undefined : line.sentence}
        onMachine={(next) => setChosen({ key: next.spade.key, name: next.machine.name })}
      />
    </SpadeMachineScope>
  );
}

function NewBotConversation(props: {
  /** A template picked before the page opened, by id. */
  startFrom: string | undefined;
  host: SpadeHost;
  hosts: readonly SpadeHost[];
  /** Names the person's bots already have, which a template's name avoids. */
  names: readonly string[];
  blocked: string | undefined;
  onMachine(host: SpadeHost): void;
}) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [model, setModel] = useState("");
  const [template, setChosen] = useState<SpadeTemplate>();
  // A template picked on the way here is picked once its machine has listed it.
  const listed = useQuery({
    queryKey: ["spade", "templates", props.host.spade.key],
    queryFn: ({ signal }) => readTemplates(client, { signal }),
    enabled: props.startFrom !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [arrived, setArrived] = useState(props.startFrom);
  const waiting = arrived ? listed.data?.find((each) => each.id === arrived) : undefined;
  if (waiting && !template) {
    setArrived(undefined);
    setChosen(waiting);
  }
  // Its routines start unless the person turns them off here: they chose to make this bot.
  const [startRoutines, setStartRoutines] = useState(true);
  const setTemplate = (next: SpadeTemplate | undefined) => {
    setChosen(next);
    setStartRoutines(true);
  };
  // How it talks, when the person chose under More settings; else left to the bot.
  const [personality, setPersonality] = useState<SpadePersonality>();
  // Apps connected from the template's suggestions, given to the bot once it is made.
  const [apps, setApps] = useState<readonly string[]>([]);
  const models = useSpadeModels(props.blocked === undefined);
  const send = async (message: SpadeMessage) => {
    if (message.documents?.length)
      throw new Error("A first message takes words and pictures. Send other files once it's made.");
    const task = message.text.slice(0, spadeAgentTaskMax);
    const agent = await createAgent(
      client,
      template
        ? {
            // A template brings its own name, face and task; the message is its first job.
            name: spadeFreeName(template.name, props.names),
            task: "",
            template: template.id,
            ...(template.routines.length ? { start_routines: startRoutines } : {}),
            ...withZone(browserTimeZone()),
            ...(model ? { model } : {}),
            ...voiced(personality),
          }
        : // The first message is its task; it names itself as it starts.
          { task, naming: true, ...(model ? { model } : {}), ...voiced(personality) },
      message,
    );
    // A bot starts with no apps; these the person connected for it here.
    for (const connector of apps) await allowApp(client, agent.id, connector).catch(() => {});
    await cache.invalidateQueries({ queryKey: agentsKey });
    void navigate({
      to: "/spade/$agentId",
      params: { agentId: agent.id },
      search: props.host.spade.primary ? {} : { on: props.host.spade.key },
      replace: true,
    });
  };
  const name = template ? template.name : "New bot";
  return (
    <Screen page="spade" title="">
      <div data-thread-column="" className="relative grid h-full min-h-0 grid-cols-1 grid-rows-1">
        <PageScroller>
          <div className={`${readingColumn} flex min-h-full flex-col gap-6 px-1 pt-6`}>
            <section aria-label="Start from">
              <h2 className="mb-2 px-1 text-ui font-medium text-muted-foreground">Start from</h2>
              <StartFrom
                client={client}
                machineKey={props.host.spade.key}
                value={template?.id}
                onChange={setTemplate}
              />
            </section>
            <section aria-label="How it runs" className="flex flex-col gap-4">
              <SettingCard>
                <RunsWithRows
                  hosts={props.hosts}
                  host={props.host}
                  model={model}
                  newBotModel={models.data?.newBotModel}
                  firstUsable={spadeFirstUsableModel(models.data?.endpoints ?? [])}
                  onModel={setModel}
                  onMachine={(next) => {
                    // Another machine has its own models and templates.
                    setModel("");
                    setTemplate(undefined);
                    props.onMachine(next);
                  }}
                />
                {template && (
                  <TemplateRoutines
                    template={template}
                    on={startRoutines}
                    onChange={setStartRoutines}
                  />
                )}
              </SettingCard>
              <SettingCard>
                <div aria-label="Personality" role="group">
                  <PersonalityRows
                    value={personality ?? spadeQuietPersonality}
                    onChange={setPersonality}
                  />
                </div>
              </SettingCard>
            </section>
            {template && (
              <SuggestedApps
                task={template.task}
                title={`Apps ${template.name} could use`}
                onConnected={(connector) =>
                  setApps((had) => (had.includes(connector.id) ? had : [...had, connector.id]))
                }
              />
            )}
            <div className="mt-auto flex flex-col items-center gap-3 pt-6 pb-2 text-center">
              {template && <BotFace face={template.face} size={56} />}
              <h1 className="text-2xl font-semibold tracking-title text-foreground">
                {template ? `What should ${template.name} do first?` : "What should this bot do?"}
              </h1>
            </div>
          </div>
        </PageScroller>
        <SpadeComposer
          name={name}
          draftKey="spade:new-bot"
          answering={false}
          blocked={props.blocked}
          placeholder={template ? "Its first job, in your words" : "Describe the job in your words"}
          send={send}
        />
      </div>
    </Screen>
  );
}

/** The personality the person chose for the new bot, as `POST /v1/agents` takes it. */
const voiced = (personality: SpadePersonality | undefined) =>
  personality ? { personality: spadePersonalityBody(personality) } : {};

const withZone = (zone: string | undefined) => (zone === undefined ? {} : { time_zone: zone });
