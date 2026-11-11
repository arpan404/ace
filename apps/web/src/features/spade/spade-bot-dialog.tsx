import { useClient } from "@ace/client-react";
import { spadeAgentNameMax, spadeAgentTaskMax } from "@ace/ui-core/spade-chat";
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
import { AvatarChoice, type AvatarDraft } from "./spade-avatar-choice.tsx";
import { SpadeMachineScope, spadeMachineKey } from "./spade-machine.tsx";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { agentsKey, type RosterBot, type SpadeHost } from "./use-spade-roster.ts";

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
  const [hostKey, setHostKey] = useState(props.hosts[0]?.spade.key ?? "");
  const host = props.hosts.find((candidate) => candidate.spade.key === hostKey) ?? props.hosts[0];
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [avatar, setAvatar] = useState<AvatarDraft>({ kind: "generated", color: "teal" });
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const ready = name.trim() !== "" && /\/./.test(model) && host?.machine.client !== undefined;
  const create = async () => {
    const client = host?.machine.client;
    if (!ready || !client || !host) return;
    setSaving(true);
    setProblem(undefined);
    try {
      const agent = await createAgent(client, {
        name: name.trim(),
        task: task.trim(),
        model,
        avatar:
          avatar.kind === "image"
            ? avatar
            : { kind: "generated", color: avatar.kind === "generated" ? avatar.color : "slate" },
      });
      await cache.invalidateQueries({ queryKey: agentsKey });
      props.onClose();
      void navigate({
        to: "/spade/$agentId",
        params: { agentId: agent.id },
        search: host.spade.primary ? {} : { machine: host.spade.key },
      });
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
          <DialogTitle>New bot</DialogTitle>
        </DialogHeader>
        <DialogBody>
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
              value={host?.spade.key ?? ""}
              options={props.hosts.map((each) => ({
                value: spadeMachineKey(each.machine),
                label: each.machine.primary
                  ? `${each.machine.name} (this machine)`
                  : each.machine.name,
              }))}
              onValueChange={(next) => {
                setHostKey(next);
                // Another machine has its own endpoints.
                setModel("");
              }}
              className="w-72"
            />
          </Field>
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
          <Button variant="primary" disabled={!ready || saving} onClick={() => void create()}>
            {saving ? "Creating…" : "Create bot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Edit a bot, on its own machine: name, task, face and model, sent as one change of what moved.
 * Spade keeps its name and face. Task and model apply from the bot's next reply, and the dialog
 * says so in one quiet line.
 */
export function EditBotDialog(props: { bot: RosterBot; onClose(): void }) {
  const { bot } = props;
  const ids = { name: useId(), task: useId(), model: useId() };
  const client = useClient();
  const cache = useQueryClient();
  const main = bot.kind === "main";
  const [name, setName] = useState(bot.name);
  const [task, setTask] = useState(bot.task);
  const [avatar, setAvatar] = useState<AvatarDraft>({ kind: "current", avatar: bot.avatar });
  const [model, setModel] = useState(bot.model);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const change: Partial<SpadeAgentDraft> = {
    ...(!main && name.trim() !== bot.name ? { name: name.trim() } : {}),
    ...(task.trim() !== bot.task.trim() ? { task: task.trim() } : {}),
    ...(model !== bot.model && /\/./.test(model) ? { model } : {}),
    ...(!main && avatar.kind !== "current" ? { avatar } : {}),
  };
  const changed = Object.keys(change).length > 0 && (main || name.trim() !== "");
  const save = async () => {
    setSaving(true);
    setProblem(undefined);
    try {
      await editAgent(client, bot.id, change);
      await cache.invalidateQueries({ queryKey: agentsKey });
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
