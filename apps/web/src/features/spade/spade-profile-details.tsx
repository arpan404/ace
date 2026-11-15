import { spadeAccessChoices, spadeAgentTaskMax, type SpadeAccess } from "@ace/ui-core/spade-chat";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { cn } from "@/lib/cn.ts";
import { ProfileApps } from "./spade-bot-connectors.tsx";
import { ProfileSpending } from "./spade-bot-oversight.tsx";
import { ProfilePlugins } from "./spade-bot-plugins.tsx";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { useEditBot } from "./spade-profile-actions.ts";
import { pillButton, ProfileSection } from "./spade-profile-parts.tsx";
import { ProfileRoutines } from "./spade-routines.tsx";
import { useDeleteBot, useDuplicateBot, useExportBot } from "./use-bot-actions.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/**
 * Details: what the bot is and how it behaves. Its task, the model and machine it runs with,
 * its access, its routines, the apps and plugins it may use, its spending, then Duplicate,
 * Export and Delete. Everything edits where it shows.
 */
export function ProfileDetails(props: { bot: RosterBot }) {
  const { bot } = props;
  const edit = useEditBot(bot);
  const [modelProblem, setModelProblem] = useState<string>();
  return (
    <>
      <ProfileSection label="Task">
        <TaskField bot={bot} />
      </ProfileSection>
      <ProfileSection label="Runs with">
        <SettingRow
          title="Model"
          inline
          description={modelProblem && <span className="text-destructive">{modelProblem}</span>}
        >
          <SpadeModelPicker
            value={bot.model}
            onChange={(model) => {
              if (!/\/./.test(model) || model === bot.model) return;
              void edit({ model }).then(setModelProblem);
            }}
          />
        </SettingRow>
        <SettingRow title="Machine" inline>
          <span className="truncate text-ui text-foreground">{bot.machine.name}</span>
        </SettingRow>
      </ProfileSection>
      <ProfileSection label="Access" bare>
        <AccessField bot={bot} />
      </ProfileSection>
      <ProfileRoutines bot={bot} />
      <ProfileApps bot={bot} />
      <ProfilePlugins bot={bot} />
      <ProfileSpending bot={bot} />
      <Foot bot={bot} />
    </>
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

/**
 * How much it may do without asking, three words, saved the moment the person picks one, with
 * one line for the chosen level. Full access is asked about once first.
 */
function AccessField(props: { bot: RosterBot }) {
  const { bot } = props;
  const edit = useEditBot(bot);
  const saved = bot.access ?? "ask";
  // The level picked shows at once; it falls back if Spade refuses it.
  const [shown, setShown] = useState<SpadeAccess>(saved);
  const [seen, setSeen] = useState(saved);
  const [problem, setProblem] = useState<string>();
  const [asking, setAsking] = useState(false);
  if (seen !== saved) {
    setSeen(saved);
    setShown(saved);
  }
  const take = (access: SpadeAccess) => {
    setShown(access);
    setProblem(undefined);
    void edit({ access }).then((refused) => {
      if (!refused) return;
      setShown(saved);
      setProblem(refused);
    });
  };
  const line = spadeAccessChoices.find((choice) => choice.value === shown)?.line;
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-1 px-4 pt-3 pb-3">
      <SegmentedControl
        label={`${bot.name}'s access`}
        value={shown}
        options={spadeAccessChoices.map((choice) => ({ value: choice.value, label: choice.label }))}
        onValueChange={(next) => {
          if (next === shown) return;
          if (next === "full_access") setAsking(true);
          else take(next);
        }}
        className="h-8 w-full [&>button]:h-7"
      />
      <p className={cn("text-xs", problem ? "text-destructive" : "text-subtle-foreground")}>
        {problem ?? line}
      </p>
      <ConfirmDialog
        confirming={
          asking
            ? {
                title: `Give ${bot.name} full access?`,
                body: "It will never ask before it acts, even to pay, send as you, publish or delete. You keep Stop, spend limits and the activity log.",
                confirm: "Give full access",
                run: () => take("full_access"),
              }
            : undefined
        }
        onDone={() => setAsking(false)}
      />
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
            setConfirming({
              title: `Delete ${bot.name}?`,
              body: `This deletes ${bot.name} and its whole conversation.`,
              confirm: "Delete bot",
              run: () =>
                void remove(bot).then((done) => {
                  if (done) void navigate({ to: "/spade", replace: true });
                }),
            })
          }
        >
          Delete bot…
        </Button>
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </div>
  );
}
