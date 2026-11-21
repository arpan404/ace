import { spadeAgentTaskMax, type SpadePanel } from "@ace/ui-core/spade-chat";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button, buttonLook } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { cn } from "@/lib/cn.ts";
import { ProfileMachine, ProfileMoveLine } from "./spade-bot-move.tsx";
import { ProfilePackageLine } from "./spade-bot-package.tsx";
import { ProfileContracts } from "./spade-profile-contracts.tsx";
import { BotRoles } from "./spade-bot-roles.tsx";
import { ProfileReach } from "./spade-bot-reach.tsx";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { useEditBot } from "./spade-profile-actions.ts";
import { ProfileCases } from "./spade-profile-cases.tsx";
import { pillButton, ProfileSection } from "./spade-profile-parts.tsx";
import { ProfilePersonality } from "./spade-profile-personality.tsx";
import { ProfileRoutines } from "./spade-routines.tsx";
import { TaskHistory } from "./spade-task-history.tsx";
import { useDeleteBot, useDuplicateBot, useExportBot } from "./use-bot-actions.ts";
import { DeleteMakerDialog, type DeletingMaker } from "./spade-delete-maker.tsx";
import { useMakerWorkers } from "./use-spade-work.ts";
import type { RosterBot } from "./use-spade-roster.ts";
import { VoiceRows } from "./spade-voice-settings.tsx";
import { useSpadeModels } from "./use-spade-models.ts";
import { voiceKey } from "./use-spoken-replies.ts";

/**
 * Details: what the bot is and how it behaves. A move to another machine, or what needs the
 * person since one, first (ADR 0187). Its task, the model and machine it runs with
 * (and, folded, the models for its other work), how it sounds (Speak replies and its voice, on
 * this device), its routines, the apps and plugins it may use, its boundaries, its spending,
 * then Duplicate, Export and Delete. Everything edits where it shows.
 */
/** A packaged bot's panels, each opened beside its conversation (ADR 0200 §5.2). */
export interface ProfilePanels {
  list: readonly SpadePanel[];
  onOpen(panel: string): void;
}

export function ProfileDetails(props: { bot: RosterBot; panels?: ProfilePanels | undefined }) {
  const { bot } = props;
  const edit = useEditBot(bot);
  const [modelProblem, setModelProblem] = useState<string>();
  const speechModel = useSpadeModels(true).data?.speechModel;
  return (
    <>
      <ProfileMoveLine bot={bot} />
      <ProfilePackageLine bot={bot} />
      <ProfileSection label="Task">
        <TaskField bot={bot} />
        <TaskHistory bot={bot} />
      </ProfileSection>
      {props.panels && props.panels.list.length > 0 && (
        <ProfileSection label="Panels">
          {props.panels.list.map((panel) => (
            <SettingRow key={panel.id} title={panel.title} inline>
              <Button size="sm" variant="ghost" onClick={() => props.panels?.onOpen(panel.id)}>
                Open
              </Button>
            </SettingRow>
          ))}
        </ProfileSection>
      )}
      <ProfileSection label="Runs with">
        <SettingRow
          title="Model"
          inline
          description={modelProblem && <span className="text-destructive">{modelProblem}</span>}
        >
          <SpadeModelPicker
            subscriptions
            value={bot.model}
            onChange={(model) => {
              if (!/\/./.test(model) || model === bot.model) return;
              void edit({ model }).then(setModelProblem);
            }}
          />
        </SettingRow>
        <ProfileMachine bot={bot} />
        <BotRoles bot={bot} />
      </ProfileSection>
      {bot.kind === "main" && <ProfileRunning />}
      <ProfilePersonality bot={bot} />
      <ProfileSection label="Voice">
        <VoiceRows bot={voiceKey(bot.machine.key, bot.id)} speechModel={speechModel} />
      </ProfileSection>
      <ProfileRoutines bot={bot} />
      <ProfileContracts bot={bot} />
      <ProfileCases bot={bot} />
      <ProfileReach bot={bot} />
      <Foot bot={bot} />
    </>
  );
}

/**
 * Spade's own profile opens Running (ADR 0200 §6.3): Spade is what runs the bots, so what runs
 * is its to show. One row and a text button; no new place in the rail or the list's toolbar.
 */
function ProfileRunning() {
  return (
    <ProfileSection label="Running">
      <SettingRow
        title="What runs"
        inline
        description="Every bot's state, spend and next wake, with Stop, Pause and Resume."
      >
        <Link to="/spade/running" {...buttonLook({ variant: "ghost" }, pillButton)}>
          Open
        </Link>
      </SettingRow>
    </ProfileSection>
  );
}

const mayWords = { yes: "Yes", ask: "Ask me first", no: "No" } as const;

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
    <ProfileSection label="Making bots">
      <SettingRow
        title="May create bots"
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
 * The task, as prose; editing turns it into its field in place. ⌘↵ or leaving the field saves,
 * Esc puts it back.
 */
function TaskField(props: { bot: RosterBot }) {
  const { bot } = props;
  const edit = useEditBot(bot);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(bot.task);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  // Esc put it back: the blur as the field goes must not save what was dropped.
  const dropped = useRef(false);
  const save = async () => {
    if (dropped.current) return;
    const task = text.trim();
    if (task === bot.task.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const refused = await edit({ task });
    setSaving(false);
    setProblem(refused);
    if (!refused) setEditing(false);
  };
  const prose = "text-md leading-[22px]";
  if (!editing)
    return (
      <button
        type="button"
        data-setting-slot=""
        aria-label={bot.task ? `Edit the task: ${bot.task}` : "Write its task"}
        onClick={() => {
          dropped.current = false;
          setText(bot.task);
          setProblem(undefined);
          setEditing(true);
        }}
        className={cn(
          "-mx-4 rounded-lg px-4 py-3 text-left whitespace-pre-wrap focus-ring-inset hover:bg-hover",
          prose,
          bot.task ? "text-foreground" : "text-subtle-foreground",
        )}
      >
        {bot.task || "What this bot is for, in your words"}
      </button>
    );
  return (
    <div data-setting-slot="" className="flex flex-col gap-1.5 py-2">
      <textarea
        aria-label="Task"
        value={text}
        autoFocus
        rows={4}
        maxLength={spadeAgentTaskMax}
        disabled={saving}
        placeholder="What this bot is for, in your words"
        aria-invalid={problem ? true : undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            dropped.current = true;
            setText(bot.task);
            setProblem(undefined);
            setEditing(false);
          }
        }}
        className={cn(
          "-mx-2.5 resize-none rounded-md bg-chat-well px-3 py-2.5 text-foreground shadow-[inset_0_0_0_1px_var(--foreground)] outline-none [field-sizing:content] placeholder:text-subtle-foreground",
          prose,
        )}
      />
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

/** Duplicate opens the copy; Export saves its file; Delete asks first. Spade can't be deleted. */
function Foot(props: { bot: RosterBot }) {
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
    <div className="mt-6 -ml-3.5 flex flex-wrap items-center gap-1">
      <Button
        variant="ghost"
        className={pillButton}
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
      </Button>
      <Button variant="ghost" className={pillButton} onClick={() => void exportBot(bot)}>
        Export
      </Button>
      {bot.kind !== "main" && (
        <Button
          variant="ghost"
          tone="danger"
          className={cn(pillButton, "ml-auto -mr-3.5")}
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
        </Button>
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
      <DeleteMakerDialog deleting={deleting} onDone={() => setDeleting(undefined)} />
    </div>
  );
}
