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
import { createAgent, editAgent, type SpadeAgentDraft } from "./spade-api.ts";
import { ConnectorChoice, useConnectorChoice } from "./spade-bot-connectors.tsx";
import { AvatarChoice, type AvatarDraft } from "./spade-avatar-choice.tsx";
import { SpadeMachineScope, spadeMachineKey, useSpadeClient } from "./spade-machine.tsx";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { browserTimeZone, ImportBot, TemplateChoice } from "./spade-bot-start.tsx";
import { agentsKey, type RosterBot, type SpadeHost } from "./use-spade-roster.ts";
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

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * New bot (ADR 0126, 0127): its name, its task (what it is for, in the person's words), its face,
 * its model and the machine it runs on (machines whose Spade answers, this one first). Creating
 * it opens its conversation.
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
  const [avatar, setAvatar] = useState<AvatarDraft>({ kind: "generated", color: "teal" });
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
      const agent = await createAgent(client, {
        name: name.trim(),
        task: task.trim(),
        ...(chosenModel ? { model } : {}),
        ...(template === undefined ? {} : { template }),
        ...(zone === undefined ? {} : { time_zone: zone }),
        avatar:
          avatar.kind === "image"
            ? avatar
            : { kind: "generated", color: avatar.kind === "generated" ? avatar.color : "slate" },
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
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>New bot</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Field label="Start from a template">
            <TemplateChoice
              client={host?.machine.client}
              machineKey={chosen.key}
              value={template}
              onChange={(picked) => {
                setTemplate(picked?.id);
                if (!picked) return;
                setName(picked.name);
                setTask(picked.task);
                setAvatar({ kind: "generated", color: picked.color });
              }}
            />
          </Field>
          <Field label="Name" htmlFor={ids.name}>
            <Input
              id={ids.name}
              value={name}
              maxLength={spadeAgentNameMax}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Task" htmlFor={ids.task}>
            <Textarea
              id={ids.task}
              value={task}
              maxLength={spadeAgentTaskMax}
              placeholder="What this bot is for"
              onChange={(event) => setTask(event.target.value)}
            />
          </Field>
          <Field label="Face">
            <AvatarChoice name={name} value={avatar} onChange={setAvatar} />
          </Field>
          {host && (
            <SpadeMachineScope machine={host.machine}>
              <Field label="Model" htmlFor={ids.model}>
                <SpadeModelPicker id={ids.model} value={model} onChange={setModel} />
              </Field>
            </SpadeMachineScope>
          )}
          <Field label="Runs on" htmlFor={ids.machine}>
            <Select
              id={ids.machine}
              label="Runs on"
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
              className="w-72"
            />
            {!host && (
              <p role="status" className="text-xs text-muted-foreground">
                {`${chosen.name} isn't reachable right now. Wait for it, or pick another machine.`}
              </p>
            )}
          </Field>
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
 * Edit a bot, on its own machine: name, task, face, model and the connected apps it may use,
 * sent as one change of what moved. Spade keeps its name and face. Task and model apply from the
 * bot's next reply, and the dialog says so in one quiet line.
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
  const [model, setModel] = useState(bot.model);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const apps = useConnectorChoice(bot.id);
  const change: Partial<SpadeAgentDraft> = {
    ...(!main && name.trim() !== bot.name ? { name: name.trim() } : {}),
    ...(task.trim() !== bot.task.trim() ? { task: task.trim() } : {}),
    ...(model !== bot.model && /\/./.test(model) ? { model } : {}),
    ...(!main && avatar.kind !== "current" ? { avatar } : {}),
  };
  const changed = (Object.keys(change).length > 0 || apps.changed) && (main || name.trim() !== "");
  const save = async () => {
    setSaving(true);
    setProblem(undefined);
    try {
      if (Object.keys(change).length > 0) await editAgent(client, bot.id, change);
      await apps.save(client);
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
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{main ? "Edit Spade" : `Edit ${bot.name}`}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {!main && (
            <Field label="Name" htmlFor={ids.name}>
              <Input
                id={ids.name}
                value={name}
                maxLength={spadeAgentNameMax}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          )}
          <Field label="Task" htmlFor={ids.task}>
            <Textarea
              id={ids.task}
              value={task}
              maxLength={spadeAgentTaskMax}
              placeholder="What this bot is for"
              onChange={(event) => setTask(event.target.value)}
            />
          </Field>
          {!main && (
            <Field label="Face">
              <AvatarChoice name={name} value={avatar} onChange={setAvatar} />
            </Field>
          )}
          <Field label="Model" htmlFor={ids.model}>
            <SpadeModelPicker id={ids.model} value={model} onChange={setModel} />
          </Field>
          <Field label="Apps">
            <ConnectorChoice choice={apps} main={main} />
          </Field>
          <p className="text-xs text-subtle-foreground">
            {`Task and model changes apply from ${bot.name}'s next reply.`}
          </p>
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
