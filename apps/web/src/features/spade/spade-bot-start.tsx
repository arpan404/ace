import type { ClientApi } from "@ace/client";
import {
  faceForId,
  shuffleFace,
  storedBotFace,
  suggestBotNames,
  type BotFace as BotFaceModel,
} from "@ace/ui-core/bot-face";
import {
  spadeAgentNameMax,
  spadeAgentTaskMax,
  spadeNewBotAccess,
  type SpadeAccess,
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
import { createAgent, readModels, type SpadeNewAgent } from "./spade-api.ts";
import type { SpadeMessage } from "./spade-attachments.ts";
import { AvatarPopover, draftFace, type AvatarDraft } from "./spade-avatar-choice.tsx";
import { SpadeComposer } from "./spade-composer.tsx";
import { SpadeMachineScope, useSpadeClient } from "./spade-machine.tsx";
import { ConversationSkeleton, Scroller, useSpadeLine } from "./spade-screen-parts.tsx";
import { RunsWith, TemplateRows } from "./spade-new-bot-parts.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { importAgent, readTemplates } from "./spade-teams-api.ts";
import { useSpadeModels } from "./use-spade-models.ts";
import { agentsKey, useSpadeRoster, useWornPairs, type SpadeHost } from "./use-spade-roster.ts";

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

/** The face at the head of a new bot's conversation, in px (`--spade-profile-face`). */
const headFace = 96;

/** `name`, or "Research 2", "Research 3"… when a bot already has it. */
function freeName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((each) => each.trim().toLowerCase()));
  if (!used.has(name.trim().toLowerCase())) return name;
  let count = 2;
  while (used.has(`${name} ${count}`.toLowerCase())) count += 1;
  return `${name} ${count}`;
}

/** The nearest colour an older Spade, which draws initials, knows for each face colour. */
const legacyColours: Record<BotFaceModel["pair"], string> = {
  ember: "orange",
  butter: "amber",
  mint: "green",
  lagoon: "teal",
  sky: "blue",
  lilac: "violet",
  rose: "pink",
  berry: "pink",
  sage: "green",
  cocoa: "orange",
  stone: "slate",
};

/**
 * The avatar a draft sends: its picture, or its face as stored. A Spade without character
 * faces gets the name's initials in the face's nearest colour.
 */
function avatarOf(draft: AvatarDraft, name: string, characters: boolean): SpadeNewAgent["avatar"] {
  if (draft.kind === "image") return draft;
  if (draft.kind !== "face") return undefined;
  if (characters) return storedBotFace(draft.face, draft.raw);
  const initials = name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase();
  return { kind: "generated", initials, color: legacyColours[draft.face.pair] };
}

/**
 * `/spade/new` (docs/design/spade.md §5): New bot is a conversation, not a form. At its head the
 * bot as it will be: its face, which opens the face popover; its name, edited where it shows (a
 * name that suits the face until the person types one); and one quiet line, its model (the
 * model for new bots unless changed), access and machine, each changed in place. Below, the
 * templates to start from. The first message is its task: Send makes the bot and its first
 * message in one call, and opens its conversation. Import is in the list's + only.
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
      <Screen title="">
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
        <Screen title="">
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
  /** Names the person's bots already have, which a suggested name avoids. */
  names: readonly string[];
  blocked: string | undefined;
  onMachine(host: SpadeHost): void;
}) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const worn = useWornPairs();
  const [avatar, setAvatar] = useState<AvatarDraft>(() => ({
    kind: "face",
    face: shuffleFace(Math.random, undefined, worn),
  }));
  const face = draftFace(avatar);
  const [fallback] = useState(() => face ?? faceForId("new"));
  // Undefined: the name follows the face until the person types one.
  const [typed, setTyped] = useState<string>();
  const suggested =
    suggestBotNames(face ?? fallback, "").find((each) => !props.names.includes(each)) ?? "New bot";
  const name = typed ?? suggested;
  const [model, setModel] = useState("");
  const [access, setAccess] = useState<SpadeAccess>(spadeNewBotAccess);
  const [template, setTemplate] = useState<SpadeTemplate>();
  const models = useSpadeModels(props.blocked === undefined);
  const send = async (message: SpadeMessage) => {
    if (message.documents?.length)
      throw new Error("A first message takes words and pictures. Send other files once it's made.");
    const zone = template ? browserTimeZone() : undefined;
    const named = name.trim() || suggested;
    // Read now, not from the cache: the machine's Spade may have been updated since.
    const characters = (await readModels(client)).characterAvatars === true;
    const avatarSent = avatarOf(avatar, named, characters);
    const agent = await createAgent(
      client,
      {
        name: named,
        // The first message is its task; a template brings its own.
        task: template ? "" : message.text.slice(0, spadeAgentTaskMax),
        ...(model ? { model } : {}),
        access,
        ...(template ? { template: template.id } : {}),
        ...(zone === undefined ? {} : { time_zone: zone }),
        ...(avatarSent ? { avatar: avatarSent } : {}),
      },
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
  const shown = name.trim() || suggested;
  return (
    <Screen title="">
      <div data-thread-column="" className="relative grid h-full min-h-0 grid-cols-1 grid-rows-1">
        <h1 className="sr-only">New bot</h1>
        <Scroller>
          <div className="flex flex-col items-center gap-2 pt-2">
            <AvatarPopover
              value={avatar}
              fallback={face ?? fallback}
              takenPairs={worn}
              size={headFace}
              onChange={(next) => {
                setAvatar(next);
                // A template's face changed is the person's own bot now.
                setTemplate(undefined);
              }}
            />
            <input
              aria-label="Name"
              value={name}
              maxLength={spadeAgentNameMax}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
              onBlur={() => typed !== undefined && !typed.trim() && setTyped(undefined)}
              className="field-sizing-content h-8 max-w-full min-w-24 rounded-md bg-transparent px-2 text-center text-xl leading-7 font-semibold text-foreground transition-colors duration-(--motion-fast) outline-none placeholder:text-subtle-foreground hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
            />
            <RunsWith
              hosts={props.hosts}
              host={props.host}
              name={shown}
              model={model}
              newBotModel={models.data?.newBotModel}
              onModel={setModel}
              access={access}
              onAccess={setAccess}
              onMachine={(next) => {
                // Another machine has its own models and templates.
                setModel("");
                setTemplate(undefined);
                props.onMachine(next);
              }}
            />
          </div>
          <TemplateRows
            client={client}
            machineKey={props.host.spade.key}
            value={template?.id}
            onChange={(picked) => {
              setTemplate(picked);
              if (!picked) return setTyped(undefined);
              setTyped(freeName(picked.name, props.names));
              setAvatar({ kind: "face", face: picked.face });
            }}
          />
        </Scroller>
        <SpadeComposer
          name={shown}
          draftKey="spade:new-bot"
          answering={false}
          blocked={props.blocked}
          placeholder={template ? `What should ${shown} do first?` : `What should ${shown} do?`}
          send={send}
        />
      </div>
    </Screen>
  );
}
