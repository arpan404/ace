import {
  spadeAgentTaskMax,
  spadeEffortShortNames,
  spadeModelDefaultEffort,
  spadeModelEfforts,
  spadeNextModelEffort,
  splitSpadeModel,
  type SpadePanel,
  type SpadeRole,
} from "@ace/ui-core/spade-chat";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button, buttonLook } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { cn } from "@/lib/cn.ts";
import { ProfileMachine, ProfileMoveLine } from "./spade-bot-move.tsx";
import { ProfilePackageLine } from "./spade-bot-package.tsx";
import { BotRoleRows, useBotRoles } from "./spade-bot-roles.tsx";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { useEditBot } from "./spade-profile-actions.ts";
import {
  pillButton,
  ProfileCard,
  profileRowClass,
  ProfileSection,
  profileWell,
} from "./spade-profile-parts.tsx";
import { TaskHistory } from "./spade-task-history.tsx";
import { useDeleteBot, useDuplicateBot, useExportBot } from "./use-bot-actions.ts";
import { DeleteMakerDialog, type DeletingMaker } from "./spade-delete-maker.tsx";
import { useMakerWorkers } from "./use-spade-work.ts";
import type { RosterBot } from "./use-spade-roster.ts";
import { VoiceRows } from "./spade-voice-settings.tsx";
import { useSpadeModels } from "./use-spade-models.ts";
import { voiceKey } from "./use-spoken-replies.ts";

/** A packaged bot's panels, each opened beside its conversation (ADR 0200 §5.2). */
export interface ProfilePanels {
  list: readonly SpadePanel[];
  onOpen(panel: string): void;
}

/** Its package's panels, then what it is for: the Job page. */
export function ProfileJob(props: { bot: RosterBot; panels?: ProfilePanels | undefined }) {
  const { bot } = props;
  return (
    <>
      <ProfilePackageLine bot={bot} />
      <ProfileSection
        label="Task"
        note="What this bot is for, in your words. It follows this on every turn."
      >
        <TaskField bot={bot} />
        <TaskHistory bot={bot} />
      </ProfileSection>
      {props.panels && props.panels.list.length > 0 && (
        <ProfileSection label="Panels">
          {props.panels.list.map((panel) => (
            <SettingRow key={panel.id} title={panel.title} density="compact" inline>
              <Button size="sm" variant="ghost" onClick={() => props.panels?.onOpen(panel.id)}>
                Open
              </Button>
            </SettingRow>
          ))}
        </ProfileSection>
      )}
    </>
  );
}

/**
 * The Model page: the model the bot runs with and how hard it thinks (the efforts that model
 * supports; none, no control), where it runs, and a row per role for its other work.
 */
export function ProfileModel(props: { bot: RosterBot; onRole(role: SpadeRole): void }) {
  const { bot } = props;
  const edit = useEditBot(bot);
  const [modelProblem, setModelProblem] = useState<string>();
  const { roles, change } = useBotRoles(bot);
  const endpoints = useSpadeModels(true).data?.endpoints ?? [];
  const efforts = (model: string) => {
    const at = splitSpadeModel(model);
    const info = endpoints
      .find((endpoint) => endpoint.id === at.endpoint)
      ?.models.find((each) => each.id === at.model);
    return spadeModelEfforts(info);
  };
  const shown = efforts(bot.model);
  const current = roles.data?.ownEfforts.main ?? roles.data?.mainEffort;
  const pick = async (model: string) => {
    if (!/\/./.test(model) || model === bot.model) return;
    const problem = await edit({ model });
    setModelProblem(problem);
    if (problem) return;
    // A model that supports the effort in use keeps it; one that doesn't gets its own default.
    const next = spadeNextModelEffort(efforts(model), current);
    if (next && next !== current) await change({ efforts: { main: next } }).catch(() => undefined);
  };
  return (
    <>
      <ProfileMoveLine bot={bot} />
      <ProfileSection label="Runs with">
        <SettingRow
          title="Model"
          description={modelProblem && <span className="text-destructive">{modelProblem}</span>}
          density="compact"
        >
          <SpadeModelPicker
            forBots
            value={bot.model}
            className="w-full"
            onChange={(model) => void pick(model)}
          />
        </SettingRow>
        {shown.length > 0 && (
          <SettingRow title="Thinking" density="compact">
            <SegmentedControl
              label="Thinking"
              className="w-full"
              value={current ?? spadeModelDefaultEffort(shown) ?? shown[0]!}
              options={shown.map((effort) => ({
                value: effort,
                label: spadeEffortShortNames[effort],
              }))}
              onValueChange={(effort) => void change({ efforts: { main: effort } })}
            />
          </SettingRow>
        )}
        <ProfileMachine bot={bot} />
      </ProfileSection>
      <BotRoleRows bot={bot} onOpen={props.onRole} />
    </>
  );
}

/** How it sounds, on this device: the Voice page. */
export function ProfileVoice(props: { bot: RosterBot }) {
  const speechModel = useSpadeModels(true).data?.speechModel;
  return (
    <ProfileSection label="Spoken replies">
      <VoiceRows bot={voiceKey(props.bot.machine.key, props.bot.id)} speechModel={speechModel} />
    </ProfileSection>
  );
}

/**
 * Spade's own profile opens Running (ADR 0200 §6.3): Spade is what runs the bots, so what runs
 * is its to show. One row and a text button; no new place in the rail or the list's toolbar.
 */
export function ProfileRunning() {
  return (
    <ProfileSection label="Running">
      <SettingRow
        title="What runs"
        density="compact"
        inline
        description="Every bot's state, spend and next wake, with Stop, Pause and Resume."
      >
        <Link to="/spade/running" {...buttonLook({ variant: "ghost", size: "sm" }, pillButton)}>
          Open
        </Link>
      </SettingRow>
    </ProfileSection>
  );
}

const mayWords = { yes: "Yes", ask: "Ask me first", no: "No" } as const;
const mayNotes = {
  yes: "Can create helper bots and add them to its clubs on its own.",
  ask: "Asks you before creating a bot or adding one to its clubs.",
  no: "Never creates bots on its own.",
} as const;

/**
 * May create bots (ADR 0161, amendment 1): whether the bot makes bots for the person, and adds
 * bots to its clubs, by itself, after asking, or never. With anything untrusted in view it asks
 * whatever this says.
 */
export function ProfileMakesBots(props: { bot: RosterBot }) {
  const { bot } = props;
  const edit = useEditBot(bot);
  const [problem, setProblem] = useState<string>();
  return (
    <ProfileSection
      label="Bot creation"
      note={`${mayNotes[bot.mayCreateBots]} With untrusted content in view, it always asks first.`}
    >
      <SettingRow
        title="May create bots"
        density="compact"
        inline
        description={problem && <span className="text-destructive">{problem}</span>}
      >
        <Select
          label="May create bots"
          className="w-36"
          value={bot.mayCreateBots}
          options={(["yes", "ask", "no"] as const).map((value) => ({
            value,
            label: mayWords[value],
          }))}
          onValueChange={(value) => {
            if (value !== "yes" && value !== "ask" && value !== "no") return;
            if (value === bot.mayCreateBots) return;
            void edit({ may_create_bots: value }).then(setProblem);
          }}
        />
      </SettingRow>
    </ProfileSection>
  );
}

/**
 * The task as a growing multi-line field: always ready to edit, with Save and Cancel shown only
 * while editing. ⌘↵ saves, Esc puts it back.
 */
function TaskField(props: { bot: RosterBot }) {
  const { bot } = props;
  const edit = useEditBot(bot);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const [syncedTask, setSyncedTask] = useState(bot.task);
  const [text, setText] = useState(bot.task);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);

  if (bot.task !== syncedTask) {
    setSyncedTask(bot.task);
    if (!editing) setText(bot.task);
  }

  const dirty = text.trim() !== bot.task.trim();

  const cancel = () => {
    setText(bot.task);
    setProblem(undefined);
    setEditing(false);
    fieldRef.current?.blur();
  };

  const save = async () => {
    if (saving) return;
    const task = text.trim();
    if (task === bot.task.trim()) {
      setEditing(false);
      fieldRef.current?.blur();
      return;
    }
    setSaving(true);
    setProblem(undefined);
    const refused = await edit({ task });
    setSaving(false);
    setProblem(refused);
    if (!refused) {
      setText(task);
      setSyncedTask(task);
      setEditing(false);
      fieldRef.current?.blur();
    }
  };

  return (
    <div data-setting-slot="" className="flex flex-col gap-2.5 py-3">
      <textarea
        ref={fieldRef}
        aria-label="Task"
        value={text}
        rows={3}
        maxLength={spadeAgentTaskMax}
        disabled={saving}
        placeholder="What this bot is for, in your words"
        aria-invalid={problem ? true : undefined}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          if (!dirty && !saving && !problem) setEditing(false);
        }}
        onChange={(event) => {
          setText(event.target.value);
          if (!editing) setEditing(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            cancel();
          }
        }}
        className={cn(profileWell, "min-h-20 px-3 py-2.5")}
      />
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      {editing && (
        <div className="flex items-center justify-end gap-1.5">
          <Button
            type="button"
            variant="ghost"
            className="h-8 rounded-md px-3"
            disabled={saving}
            onMouseDown={(event) => event.preventDefault()}
            onClick={cancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            className="h-8 rounded-md px-3.5"
            disabled={saving || !dirty}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Duplicate opens the copy; Export saves its file; Delete asks first. Spade can't be deleted. */
export function ProfileBotActions(props: { bot: RosterBot }) {
  const { bot } = props;
  const navigate = useNavigate();
  const duplicate = useDuplicateBot();
  const exportBot = useExportBot();
  const remove = useDeleteBot();
  const [confirming, setConfirming] = useState<Confirming>();
  const [deleting, setDeleting] = useState<DeletingMaker>();
  const workersOf = useMakerWorkers(bot);
  const deleted = (done: boolean) => {
    if (done) void navigate({ to: "/spade", replace: true });
  };
  return (
    <>
      <ProfileCard>
        <button
          type="button"
          data-setting-slot=""
          className={cn(profileRowClass, "min-h-11 py-2.5 text-ui text-foreground")}
          onClick={() =>
            void duplicate(bot).then((copy) => {
              if (copy)
                void navigate({
                  to: "/spade/$agentId",
                  params: { agentId: copy.id },
                  search: {
                    ...(bot.machine.primary ? {} : { on: bot.machine.key }),
                    profile: "details",
                  },
                });
            })
          }
        >
          Duplicate
        </button>
        <button
          type="button"
          data-setting-slot=""
          className={cn(profileRowClass, "min-h-11 py-2.5 text-ui text-foreground")}
          onClick={() => void exportBot(bot)}
        >
          Export
        </button>
        {bot.kind !== "main" && (
          <button
            type="button"
            data-setting-slot=""
            className={cn(
              profileRowClass,
              "min-h-11 py-2.5 text-ui text-destructive hover:bg-destructive/10 active:bg-destructive/15",
            )}
            onClick={() =>
              void workersOf().then((made) => {
                // A bot that made workers asks one thing: stop them, or keep them going.
                if (made.workers.length)
                  return setDeleting({
                    name: bot.name,
                    ...made,
                    run: (workers) => void remove(bot, workers).then(deleted),
                  });
                setConfirming({
                  title: `Delete ${bot.name}?`,
                  body: `This deletes ${bot.name} and its whole conversation.`,
                  confirm: "Delete bot",
                  run: () => void remove(bot).then(deleted),
                });
              })
            }
          >
            Delete bot…
          </button>
        )}
      </ProfileCard>
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
      <DeleteMakerDialog deleting={deleting} onDone={() => setDeleting(undefined)} />
    </>
  );
}
