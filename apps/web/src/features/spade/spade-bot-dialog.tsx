import {
  faceForId,
  shuffleFace,
  storedBotFace,
  suggestBotNames,
  type BotFace as BotFaceModel,
} from "@ace/ui-core/bot-face";
import { spadeAgentNameMax, spadeAgentTaskMax, type SpadeAgent } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { createAgent, editAgent, readModels, type SpadeAgentDraft } from "./spade-api.ts";
import { ConnectorChoice, useConnectorChoice } from "./spade-bot-connectors.tsx";
import { AvatarChoice, draftFace, type AvatarDraft } from "./spade-avatar-choice.tsx";
import { SpadeMachineScope, spadeMachineKey, useSpadeClient } from "./spade-machine.tsx";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { OversightFields, useOversightChoice } from "./spade-bot-oversight.tsx";
import { browserTimeZone, ImportBot, TemplateChoice } from "./spade-bot-start.tsx";
import { agentsKey, useWornPairs, type RosterBot, type SpadeHost } from "./use-spade-roster.ts";
import { connectorsKey } from "./spade-connector-api.ts";

function Field(props: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.htmlFor} className="w-fit text-ui font-medium">
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

/** The avatar a draft sends: its picture, or its face as stored. */
const sent = (draft: AvatarDraft): SpadeAgentDraft["avatar"] | undefined => {
  if (draft.kind === "image") return draft;
  if (draft.kind === "face") return storedBotFace(draft.face, draft.raw);
  return undefined;
};

/**
 * A name field with names that suit the face under it, one click to take one. Suggestions
 * show only while there is a face to suit.
 */
function NameField(props: {
  id: string;
  value: string;
  face: BotFaceModel | undefined;
  onChange(name: string): void;
}) {
  const names = props.face ? suggestBotNames(props.face, props.value) : [];
  return (
    <Field label="Name" htmlFor={props.id}>
      <Input
        id={props.id}
        value={props.value}
        maxLength={spadeAgentNameMax}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {names.length > 0 && (
        <div className="-ml-2 flex flex-wrap gap-1" aria-label="Names that suit this face">
          {names.map((each) => (
            <Button key={each} size="sm" variant="ghost" onClick={() => props.onChange(each)}>
              {each}
            </Button>
          ))}
        </div>
      )}
    </Field>
  );
}

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

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * New bot (ADR 0126, 0127) in two panes: its face on the left (Shuffle, the creature and its
 * colours, More for the rest); on the right its name, a template to start from, its task (what
 * it is for, in the person's words), its model and the machine it runs on (machines whose Spade
 * answers, this one first). Creating it opens its conversation.
 */
export function NewBotDialog(props: { hosts: readonly SpadeHost[]; onClose(): void }) {
  const ids = { name: useId(), task: useId(), model: useId(), machine: useId() };
  const cache = useQueryClient();
  const navigate = useNavigate();
  // The machine the person chose, kept while it is out of reach: never another one silently.
  const [chosen, setChosen] = useState(() => ({
    key: props.hosts[0]?.spade.key ?? "",
    name: props.hosts[0]?.machine.name ?? "",
  }));
  const host = props.hosts.find((candidate) => candidate.spade.key === chosen.key);
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const worn = useWornPairs();
  const [avatar, setAvatar] = useState<AvatarDraft>(() => ({
    kind: "face",
    face: shuffleFace(Math.random, undefined, worn),
  }));
  const [model, setModel] = useState("");
  const [template, setTemplate] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  /** A bot just imported, with what its machine left out, shown before it opens. */
  const [imported, setImported] = useState<{
    agent: SpadeAgent;
    leftOut: readonly string[];
    host: SpadeHost;
  }>();
  const chosenModel = /\/./.test(model);
  // A template picks the model when none is chosen.
  const ready =
    name.trim() !== "" &&
    (chosenModel || template !== undefined) &&
    host?.machine.client !== undefined;
  /** Opens a new bot on the machine it was made on. */
  const openBot = async (agent: SpadeAgent, on: SpadeHost) => {
    await cache.invalidateQueries({ queryKey: agentsKey });
    props.onClose();
    void navigate({
      to: "/spade/$agentId",
      params: { agentId: agent.id },
      search: on.spade.primary ? {} : { on: on.spade.key },
    });
  };
  const create = async () => {
    const client = host?.machine.client;
    if (!ready || !client || !host) return;
    setSaving(true);
    setProblem(undefined);
    try {
      const zone = template === undefined ? undefined : browserTimeZone();
      const supported = (await readModels(client)).characterAvatars;
      const face =
        avatar.kind === "face" && !supported
          ? {
              kind: "generated",
              initials: name
                .trim()
                .split(/\s+/u)
                .slice(0, 2)
                .map((word) => Array.from(word)[0] ?? "")
                .join("")
                .toUpperCase(),
              color: legacyColours[avatar.face.pair],
            }
          : sent(avatar);
      const agent = await createAgent(client, {
        name: name.trim(),
        task: task.trim(),
        ...(chosenModel ? { model } : {}),
        ...(template === undefined ? {} : { template }),
        ...(zone === undefined ? {} : { time_zone: zone }),
        ...(face ? { avatar: face } : {}),
      });
      await openBot(agent, host);
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(false);
    }
  };
  if (imported)
    return (
      <Dialog open onOpenChange={(open) => !open && void openBot(imported.agent, imported.host)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{`${imported.agent.name} is here`}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-ui">This machine left out:</p>
            <ul aria-label="Left out" className="flex flex-col gap-1 text-ui text-muted-foreground">
              {imported.leftOut.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onClick={() => void openBot(imported.agent, imported.host)}>
              {`Open ${imported.agent.name}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>New bot</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {/* Its face on the left; what it is, on the right. */}
          <div className="grid gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            <Field label="Face">
              <AvatarChoice
                value={avatar}
                fallback={draftFace(avatar) ?? faceForId(name || "new")}
                takenPairs={worn}
                onChange={setAvatar}
              />
            </Field>
            <div className="flex min-w-0 flex-col gap-4">
              <NameField id={ids.name} value={name} face={draftFace(avatar)} onChange={setName} />
              <Field label="Start from">
                <TemplateChoice
                  client={host?.machine.client}
                  machineKey={chosen.key}
                  value={template}
                  onChange={(picked) => {
                    setTemplate(picked?.id);
                    if (!picked) return;
                    setName(picked.name);
                    setTask(picked.task);
                    setAvatar({ kind: "face", face: picked.face });
                  }}
                />
              </Field>
              <Field label="Task" htmlFor={ids.task}>
                <Textarea
                  id={ids.task}
                  value={task}
                  maxLength={spadeAgentTaskMax}
                  placeholder="What this bot is for, in your words"
                  onChange={(event) => setTask(event.target.value)}
                />
              </Field>
              <div className="flex flex-col gap-4">
                {host && (
                  <SpadeMachineScope machine={host.machine}>
                    <Field label="Model" htmlFor={ids.model}>
                      <SpadeModelPicker id={ids.model} value={model} onChange={setModel} />
                    </Field>
                  </SpadeMachineScope>
                )}
                <Field label="Machine" htmlFor={ids.machine}>
                  <Select
                    id={ids.machine}
                    label="Machine"
                    value={chosen.key}
                    options={[
                      ...props.hosts.map((each) => ({
                        value: spadeMachineKey(each.machine),
                        label: each.machine.primary
                          ? `${each.machine.name} (this machine)`
                          : each.machine.name,
                      })),
                      ...(host ? [] : [{ value: chosen.key, label: chosen.name, disabled: true }]),
                    ]}
                    onValueChange={(next) => {
                      const picked = props.hosts.find((each) => each.spade.key === next);
                      if (!picked) return;
                      setChosen({ key: next, name: picked.machine.name });
                      // Another machine has its own endpoints and templates.
                      setModel("");
                      setTemplate(undefined);
                    }}
                    className="w-full"
                  />
                  {!host && (
                    <p role="status" className="text-xs text-muted-foreground">
                      {`${chosen.name} isn't reachable right now. Wait for it, or pick another machine.`}
                    </p>
                  )}
                </Field>
              </div>
            </div>
          </div>
          {problem && (
            <p role="alert" className="text-ui text-destructive">
              {problem}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <ImportBot
            host={host}
            onProblem={setProblem}
            onImported={(agent, leftOut, at) =>
              leftOut.length ? setImported({ agent, leftOut, host: at }) : void openBot(agent, at)
            }
          />
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || saving} onClick={() => void create()}>
            {saving ? "Creating…" : "Create bot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Edit a bot, on its own machine: name, task, face, model, the connected apps it may use, its
 * spending caps and its model review (ADR 0135), each sent as one change of what moved, in New
 * bot's two panes (its face on the left). Spade keeps its name and face.
 */
export function EditBotDialog(props: { bot: RosterBot; onClose(): void }) {
  const { bot } = props;
  const ids = { name: useId(), task: useId(), model: useId() };
  const client = useSpadeClient();
  const cache = useQueryClient();
  const main = bot.kind === "main";
  const [name, setName] = useState(bot.name);
  const [task, setTask] = useState(bot.task);
  const [avatar, setAvatar] = useState<AvatarDraft>({ kind: "current", avatar: bot.avatar });
  const worn = useWornPairs(bot.id);
  const unchangedFace =
    avatar.kind === "face" &&
    bot.avatar.kind === "character" &&
    JSON.stringify(avatar.face) === JSON.stringify(bot.avatar.face);
  const [model, setModel] = useState(bot.model);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const apps = useConnectorChoice(bot.id);
  const oversight = useOversightChoice(bot);
  const face = unchangedFace || main ? undefined : sent(avatar);
  const change: Partial<SpadeAgentDraft> = {
    ...(!main && name.trim() !== bot.name ? { name: name.trim() } : {}),
    ...(task.trim() !== bot.task.trim() ? { task: task.trim() } : {}),
    ...(model !== bot.model && /\/./.test(model) ? { model } : {}),
    ...(face ? { avatar: face } : {}),
  };
  const changed =
    (Object.keys(change).length > 0 || apps.changed || oversight.changed) &&
    !oversight.invalid &&
    (main || name.trim() !== "");
  const save = async () => {
    setSaving(true);
    setProblem(undefined);
    try {
      if (Object.keys(change).length > 0) await editAgent(client, bot.id, change);
      await apps.save(client);
      await oversight.save(client);
      await cache.invalidateQueries({ queryKey: agentsKey });
      await cache.invalidateQueries({ queryKey: connectorsKey });
      props.onClose();
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size={main ? "lg" : "xl"}>
        <DialogHeader>
          <DialogTitle>{main ? "Edit Spade" : `Edit ${bot.name}`}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div
            className={
              main ? "flex flex-col gap-4" : "grid gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]"
            }
          >
            {!main && (
              <Field label="Face">
                <AvatarChoice
                  value={avatar}
                  fallback={draftFace(avatar) ?? faceForId(bot.id)}
                  takenPairs={worn}
                  onChange={setAvatar}
                />
              </Field>
            )}
            <div className="flex min-w-0 flex-col gap-4">
              {!main && (
                <NameField id={ids.name} value={name} face={draftFace(avatar)} onChange={setName} />
              )}
              <Field label="Task" htmlFor={ids.task}>
                <Textarea
                  id={ids.task}
                  value={task}
                  maxLength={spadeAgentTaskMax}
                  placeholder="What this bot is for, in your words"
                  onChange={(event) => setTask(event.target.value)}
                />
              </Field>
              <Field label="Model" htmlFor={ids.model}>
                <SpadeModelPicker id={ids.model} value={model} onChange={setModel} />
              </Field>
              <Field label="Apps">
                <ConnectorChoice choice={apps} main={main} />
              </Field>
              <OversightFields choice={oversight} />
            </div>
          </div>
          {problem && (
            <p role="alert" className="text-ui text-destructive">
              {problem}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!changed || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
