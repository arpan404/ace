import type { ClientApi } from "@ace/client";
import {
  spadeAgentTaskMax,
  spadeFirstUsableModel,
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
import { SpadeMachineScope, useSpadeClient } from "./spade-machine.tsx";
import { ConversationSkeleton, PageScroller, useSpadeLine } from "./spade-screen-parts.tsx";
import { RunsWith, StartChips } from "./spade-new-bot-parts.tsx";
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

/** `name`, or "Research 2", "Research 3"… when a bot already has it. */
function freeName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((each) => each.trim().toLowerCase()));
  if (!used.has(name.trim().toLowerCase())) return name;
  let count = 2;
  while (used.has(`${name} ${count}`.toLowerCase())) count += 1;
  return `${name} ${count}`;
}

/**
 * `/spade/new` (docs/design/spade.md §5): a new bot starts from one message. The page asks "What
 * should this bot do?" over the composer; what the person sends is the bot's task and its first
 * message, in one call, and the bot's conversation opens on it. There the bot names itself and
 * picks its face (both changed in place with a click), says the job back, asks only what it must,
 * and starts. Under the composer, the templates as chips, one press each, and More settings: the
 * model and machine, never required. Import is in the list's + only.
 */
export function NewBotStart() {
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
  const [template, setTemplate] = useState<SpadeTemplate>();
  const [more, setMore] = useState(false);
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
            name: freeName(template.name, props.names),
            task: "",
            template: template.id,
            ...withZone(browserTimeZone()),
            ...(model ? { model } : {}),
          }
        : // The first message is its task; it names itself as it starts.
          { task, naming: true, ...(model ? { model } : {}) },
      message,
    );
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
          <div className="flex min-h-[40vh] flex-col items-center justify-end gap-3 pb-2 text-center">
            {template && <BotFace face={template.face} size={64} />}
            <h1 className="text-2xl font-semibold tracking-title text-foreground">
              {template ? `What should ${template.name} do first?` : "What should this bot do?"}
            </h1>
            {more && (
              <RunsWith
                hosts={props.hosts}
                host={props.host}
                name={name}
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
            )}
          </div>
        </PageScroller>
        <SpadeComposer
          name={name}
          draftKey="spade:new-bot"
          answering={false}
          blocked={props.blocked}
          placeholder={template ? "Its first job, in your words" : "Describe the job in your words"}
          send={send}
          below={
            <StartChips
              client={client}
              machineKey={props.host.spade.key}
              value={template?.id}
              onChange={setTemplate}
              more={more}
              onMore={() => setMore(!more)}
            />
          }
        />
      </div>
    </Screen>
  );
}

const withZone = (zone: string | undefined) => (zone === undefined ? {} : { time_zone: zone });
