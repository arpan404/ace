import { useConnectionState, useThreadMeta } from "@ace/client-react";
import {
  WorkspaceId,
  type ExecutionOptions,
  type PermissionMode,
  type Thread,
} from "@ace/protocol";
import {
  accountTag,
  choiceForModel,
  choiceSelection,
  currentModelChoice,
  modelControlName,
  nextOptions,
  optionEffort,
  permissionLabel,
  pickerModelsFromChoices,
  pickerProviders,
  providerNames,
  recordedChoice,
  speedControl,
  threadEffortControl,
  threadPermissionSummary,
  type ModelChoice,
} from "@ace/ui-core";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { ModelControl, useModelChoices, type ModelControlView } from "@/features/models/index.ts";
import { failureMessage } from "@/lib/daemon-command.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { SwitchDialog } from "../transitions/switch-dialog.tsx";
import { useComposerCompact } from "./composer-compact.ts";
import { chipControl } from "./composer-styles.ts";
import { usePermissionCapabilities, useSetThreadPermission } from "./permission-hooks.ts";
import { PermissionPicker } from "./permission-picker.tsx";

/**
 * The thread's approval mode, inspectable and changeable after the thread started. A change
 * applies from the agent's next turn (ADR 0061); until then the chip marks it pending.
 */
export function ThreadPermissionControl(props: { thread: ThreadRef }) {
  const meta = useThreadMeta(props.thread.id);
  const toast = useToast();
  const set = useSetThreadPermission(props.thread.id);
  const [defaultMode] = useDaemonSetting("permissions.defaultMode", {
    workspaceId: WorkspaceId.parse(props.thread.workspaceId),
  });
  const { capabilities, loading, failed } = usePermissionCapabilities(
    meta?.provider,
    meta?.capabilities?.permissions,
  );
  const summary = threadPermissionSummary(meta?.permission, capabilities);
  const change = (mode: PermissionMode | null) =>
    void set(mode).then(
      () =>
        toast.add({
          title: mode ? `Approvals: ${permissionLabel(mode)}` : "Approvals follow the default",
          description: "Applies from the agent's next turn.",
        }),
      (error: unknown) =>
        toast.add({ title: "Couldn't change approvals", description: failureMessage(error) }),
    );
  return (
    <PermissionPicker
      mode={summary?.mode}
      capabilities={capabilities}
      provider={meta?.provider}
      loading={loading || (!meta?.permission && !failed)}
      unavailable={
        failed && !meta?.permission
          ? "The daemon didn't say how this thread is approved"
          : undefined
      }
      pending={summary?.pending}
      inherited={summary?.inherited}
      defaultMode={defaultMode}
      onChange={change}
    />
  );
}

/** What a thread runs on: a switch waiting for its next turn, else its execution or live fields. */
function runsOn(meta: Thread | undefined) {
  if (!meta) return undefined;
  if (meta.switch?.state === "queued") return meta.switch.selection;
  return (
    meta.execution ?? {
      provider: meta.provider,
      model: meta.live?.model,
      instanceId: meta.live?.account,
      options: meta.live?.options ?? {},
    }
  );
}

/** Which provider, model and account a selection names; a cached choice belongs to one. */
function selectionIdentity(selection: ReturnType<typeof runsOn>): string {
  if (!selection) return "";
  return JSON.stringify([selection.provider, selection.model ?? "", selection.instanceId ?? ""]);
}

const offlineNote = "Offline: changes apply when the daemon is back";
const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const limitReached = (resetsAt: number | undefined) =>
  resetsAt === undefined ? "Limit reached" : `Limit reached · resets ${clock.format(resetsAt)}`;
const none: ExecutionOptions = {};

/**
 * Effort and speed the person picked for the thread's next message, sent with it as
 * `thread.send` options; undefined while nothing differs from what the thread runs with.
 */
export interface NextTurn {
  options: ExecutionOptions | undefined;
  onChange(options: ExecutionOptions | undefined): void;
}

/**
 * The thread's model, account, effort and speed. Another model or account continues the thread
 * from its next turn (another provider asks first, since the agent's private state stays
 * behind). Effort and speed go with the next message, where the provider takes them as session
 * options.
 */
export function ThreadModelControl(props: { thread: ThreadRef; busy: boolean; next: NextTurn }) {
  const meta = useThreadMeta(props.thread.id);
  const sources = useThreadSources();
  const toast = useToast();
  const choices = useModelChoices();
  const statuses = useProviderStatuses();
  const compact = useComposerCompact();
  const [switching, setSwitching] = useState<ModelChoice>();
  const online = useConnectionState() === "ready";
  const selection = runsOn(meta);
  const current = currentModelChoice(choices, selection);
  // Offline the catalog can't be read: keep what this view last knew, but only for the selection
  // it was known for (a queued switch moves to another). Anything else, including a provider the
  // catalog doesn't list, shows the thread's record.
  const selectionKey = selectionIdentity(selection);
  const [known, setKnown] = useState<{ key: string; choice: ModelChoice }>();
  if (current && (current.id !== known?.choice.id || selectionKey !== known.key))
    setKnown({ key: selectionKey, choice: current });
  const remembered = known?.key === selectionKey ? known.choice : undefined;
  const shown = current ?? (online ? undefined : remembered) ?? recordedChoice(selection);
  const base = selection?.options ?? none;
  const options = props.next.options ?? base;
  const effort = threadEffortControl({
    choice: shown,
    capabilities: meta?.capabilities,
    current: optionEffort(options),
  });
  const speed = speedControl({
    model: shown && { label: shown.model, provider: shown.provider, fastTier: shown.fastTier },
    current: options["serviceTier"],
    capabilities: meta?.capabilities,
    running: true,
  });
  const change = (patch: Record<string, string | undefined>) =>
    props.next.onChange(nextOptions(base, options, patch));
  const switchTo = (choice: ModelChoice) => {
    setSwitching(undefined);
    // Effort and speed picked for the old model don't carry over to another one.
    props.next.onChange(undefined);
    sources.actions.switchTo(props.thread, choiceSelection(choice)).then(
      () =>
        toast.add({
          title: props.busy
            ? `Switches to ${choice.model} after this turn`
            : `Continues on ${choice.model}`,
        }),
      (error: unknown) =>
        toast.add({ title: "Couldn't switch the model", description: failureMessage(error) }),
    );
  };
  const account = shown?.account ? accountTag(shown.account) : undefined;
  const name = shown
    ? modelControlName({
        model: shown.model,
        account,
        effort: effort.current,
        effortDefault: !effort.reported,
        hasEfforts: effort.efforts.length > 0,
        fast: speed.on,
      })
    : undefined;
  const pending = props.next.options ? "applies with your next message" : undefined;
  const models = pickerModelsFromChoices(choices, limitReached);
  const view: ModelControlView = {
    provider: shown?.provider,
    label: shown?.model,
    placeholder: "Model",
    ariaLabel: name ? `Model: ${name}` : "Choose a model",
    tip: shown
      ? [providerNames[shown.provider], name, pending].filter(Boolean).join(" · ")
      : "Choose a model",
    offline: online ? undefined : offlineNote,
    modelKey: shown?.key,
    efforts: effort.efforts,
    effort: effort.current,
    effortDefault: !effort.reported,
    effortReason: effort.reason,
    fast: speed.on,
    fastReason: speed.reason,
    canReset: optionEffort(options) !== undefined || options["serviceTier"] !== undefined,
    accounts: shown?.account
      ? choices
          .filter((choice) => choice.key === shown.key && choice.account)
          .map((choice) => ({
            id: choice.id,
            label: accountTag(choice.account),
            detail: choice.note,
            disabled: choice.exhausted ? limitReached(choice.resetsAt) : undefined,
          }))
      : [],
    account: current?.id,
    models,
    providers: pickerProviders(models, statuses.data ?? []),
  };
  return (
    <>
      <ModelControl
        view={view}
        className={chipControl}
        compact={compact}
        actions={{
          onEffort: (next) => change({ effort: next }),
          onFast: (on) => change({ serviceTier: on ? speed.tier : undefined }),
          onReset: () => change({ effort: undefined, serviceTier: undefined }),
          onModel: (key) => {
            const choice = choiceForModel(choices, key, current?.accountId);
            if (!choice || choice.id === current?.id) return true;
            if (meta && choice.provider !== (selection?.provider ?? meta.provider)) {
              setSwitching(choice);
              return false;
            }
            switchTo(choice);
            return true;
          },
          onAccount: (id) => {
            const choice = choices.find((candidate) => candidate.id === id);
            if (choice) switchTo(choice);
          },
        }}
      />
      {switching && meta && (
        <SwitchDialog
          from={selection?.provider ?? meta.provider}
          to={switching}
          busy={props.busy}
          onConfirm={() => switchTo(switching)}
          onClose={() => setSwitching(undefined)}
        />
      )}
    </>
  );
}

/** The thread composer's footer controls: the model (with effort and speed), then approvals. */
export function ThreadControls(props: { thread: ThreadRef; busy: boolean; next: NextTurn }) {
  return (
    <>
      <ThreadModelControl thread={props.thread} busy={props.busy} next={props.next} />
      <ThreadPermissionControl thread={props.thread} />
    </>
  );
}
