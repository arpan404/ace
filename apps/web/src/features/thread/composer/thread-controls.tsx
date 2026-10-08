import { useConnectionState, useThreadMeta } from "@ace/client-react";
import { WorkspaceId, type ExecutionOptions, type PermissionMode } from "@ace/protocol";
import {
  accountTag,
  choiceForModel,
  currentModelChoice,
  modelControlName,
  nextOptions,
  optionEffort,
  permissionCoverageNote,
  permissionLabel,
  permissionOption,
  permissionOptions,
  permissionPendingNote,
  permissionUnavailable,
  pickerModelsFromChoices,
  pickerProviders,
  providerNames,
  reconcileNextOptions,
  recordedChoice,
  speedControl,
  threadEffortControl,
  threadPermissionSummary,
  type ModelChoice,
} from "@ace/ui-core";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import {
  ModelControl,
  useModelCatalogState,
  useModelChoices,
  type ModelControlView,
} from "@/features/models/index.ts";
import { failureMessage } from "@/lib/daemon-command.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import type { ThreadRef } from "../sources/index.ts";
import { SwitchDialog } from "../transitions/switch-dialog.tsx";
import { useComposerCompact } from "./composer-compact.ts";
import { chipControl } from "./composer-styles.ts";
import { runsOn, selectionIdentity, type PendingTurn } from "./execution.ts";
import { useModelSwitch } from "./use-model-switch.ts";
import { usePermissionModes, useThreadPermission } from "./permission-hooks.ts";
import { PermissionPicker } from "./permission-picker.tsx";

/** Native mode changes stay pending until the harness acknowledges the new selection. */
export function ThreadPermissionControl(props: { thread: ThreadRef }) {
  const meta = useThreadMeta(props.thread.id);
  const toast = useToast();
  const permission = useThreadPermission(props.thread.id, meta?.permission);
  const [providerModes] = useDaemonSetting("permissions.providerModes", {
    workspaceId: WorkspaceId.parse(props.thread.workspaceId),
  });
  const defaultMode = meta ? (providerModes?.[meta.provider] ?? null) : null;
  const change = (mode: PermissionMode | null) =>
    void permission
      .change(mode)
      .catch((error: unknown) =>
        toast.add({ title: "Couldn't change approvals", description: failureMessage(error) }),
      );
  const { capabilities, loading, failed, setCurrentId } = usePermissionModes(meta?.provider, {
    currentId:
      permission.chosen !== undefined ? permission.chosen : (meta?.permission?.override ?? null),
    setCurrentId: change,
    live: (meta?.effectiveCapabilities ?? meta?.capabilities)?.permissions,
  });
  const summary = threadPermissionSummary(meta?.permission, capabilities, {
    chosen: permission.chosen,
    defaultMode,
  });
  const wanted = summary?.next ?? summary?.mode;
  const blocked =
    meta && wanted && permissionUnavailable(capabilities, wanted, providerNames[meta.provider]);
  return (
    <PermissionPicker
      current={summary && permissionOption(summary.mode, capabilities)}
      next={summary?.next ? permissionOption(summary.next, capabilities) : undefined}
      note={summary?.next && (permission.note ?? permissionPendingNote())}
      detail={summary?.coverage}
      inherited={summary?.inherited}
      menu={{
        options: permissionOptions(capabilities),
        value: wanted ?? undefined,
        loading: loading || (!meta?.permission && !failed),
        unavailable:
          failed && !meta?.permission
            ? "The daemon didn't say how this thread is approved"
            : undefined,
        coverage: permissionCoverageNote(
          capabilities,
          meta ? providerNames[meta.provider] : "This provider",
          wanted,
        ),
        fallback: blocked ? `${blocked}; choose another mode for this thread` : undefined,
        reset: !summary?.inherited
          ? { label: permissionLabel(defaultMode, capabilities) }
          : undefined,
      }}
      onChange={setCurrentId}
    />
  );
}

/** Offline, changes still go: effort and speed with the next message, a switch from the outbox. */
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
 * Effort and speed the person picked for the thread's next message (held by the composer, which
 * sends them), and how to change them; undefined while nothing differs from what it runs with.
 */
export interface NextTurn {
  pending: PendingTurn | undefined;
  onChange(pending: PendingTurn | undefined): void;
}

const droppedWords = { effort: "Effort", speed: "Speed" } as const;

/**
 * The thread's model, account, effort and speed. Another model or account continues the thread
 * from its next turn (another provider asks first, since the agent's private state stays
 * behind). Effort and speed go with the next message, where the provider takes them as session
 * options. They belong to the selection they were picked for: when the thread moves (here, or
 * from another device), what the new model doesn't take is reset, and the person is told.
 */
export function ThreadModelControl(props: { thread: ThreadRef; busy: boolean; next: NextTurn }) {
  const meta = useThreadMeta(props.thread.id);
  const toast = useToast();
  const choices = useModelChoices();
  const catalog = useModelCatalogState();
  const statuses = useProviderStatuses();
  const compact = useComposerCompact();
  const [asking, setAsking] = useState<ModelChoice>();
  const moving = useModelSwitch(props.thread, meta, choices);
  const online = useConnectionState() === "ready";
  const selection = runsOn(meta);
  const current = currentModelChoice(choices, selection);
  // Offline the catalog can't be read: keep what this view last knew, but only for the selection
  // it was known for (a queued switch moves to another). Anything else, including a provider the
  // catalog doesn't list, shows the thread's record.
  const selectionKey = selectionIdentity(selection);
  const pending =
    props.next.pending?.identity === selectionKey ? props.next.pending.options : undefined;
  const [known, setKnown] = useState<{ key: string; choice: ModelChoice }>();
  if (current && (current.id !== known?.choice.id || selectionKey !== known.key))
    setKnown({ key: selectionKey, choice: current });
  const remembered = known?.key === selectionKey ? known.choice : undefined;
  const shown = current ?? (online ? undefined : remembered) ?? recordedChoice(selection);
  const base = selection?.options ?? none;
  const options = pending ?? base;
  const effort = threadEffortControl({
    choice: shown,
    capabilities: meta?.capabilities,
    current: optionEffort(options),
  });
  const speed = speedControl({
    model: shown && {
      label: shown.model,
      provider: shown.provider,
      fastTier: shown.fastTier,
      fastDefault: shown.fastDefault,
    },
    current: options["serviceTier"],
    capabilities: meta?.capabilities,
    running: true,
  });
  const change = (patch: Record<string, string | undefined>) => {
    const next = nextOptions(base, options, patch);
    props.next.onChange(next && { identity: selectionKey, options: next });
  };
  // The thread moved since effort or speed was picked: keep what its model still takes.
  const stale = props.next.pending?.identity !== selectionKey ? props.next.pending : undefined;
  const catalogued = current !== undefined;
  const reconciled = useRef<PendingTurn>(undefined);
  useEffect(() => {
    if (!stale || !shown || !catalogued || reconciled.current === stale) return;
    reconciled.current = stale;
    const { options: kept, dropped } = reconcileNextOptions({
      base,
      pending: stale.options,
      efforts: shown.efforts,
      effortAllowed: effort.reason === undefined,
      fastTier: shown.fastTier,
      speedAllowed: speed.reason === undefined,
    });
    props.next.onChange(kept && { identity: selectionKey, options: kept });
    if (dropped.length)
      toast.add({
        title: `${dropped.map((word, at) => (at ? word : droppedWords[word])).join(" and ")} reset for ${shown.model}`,
        description: "What you picked doesn't apply to the model the thread runs on now.",
      });
  });
  const switchTo = (choice: ModelChoice) => {
    setAsking(undefined);
    // The chip shows the new model at once. Effort and speed picked for the old one stay until
    // the switch lands; then they're checked against the new model (a refused switch takes the
    // choice back and keeps them as they were).
    moving.switchTo(choice).then(
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
  // What the chip names: the switch just chosen here, else what the thread runs on next.
  const target = moving.chosen ?? shown;
  const account = target?.account ? accountTag(target.account) : undefined;
  const details = {
    model: target?.model ?? "",
    account,
    effort: effort.current,
    effortDefault: !effort.reported,
    hasEfforts: effort.efforts.length > 0,
    fast: speed.on,
  };
  const name = target && modelControlName(details);
  const waiting = pending ? "applies with your next message" : undefined;
  const switchWaits = moving.waiting(target);
  const models = pickerModelsFromChoices(choices, limitReached);
  const view: ModelControlView = {
    provider: target?.provider,
    label: target?.model,
    placeholder: "Model",
    ariaLabel: name ? `Model: ${name}` : "Choose a model",
    tip: target
      ? [modelControlName({ ...details, provider: target.provider }), waiting]
          .filter(Boolean)
          .join(" · ")
      : "Choose a model",
    switching: switchWaits,
    offline: online ? undefined : offlineNote,
    modelKey: target?.key,
    instance: target?.accountId || undefined,
    efforts: effort.efforts,
    // Without a known default, the provider's own default is a stop of its own.
    defaultStop: shown?.defaultEffort === undefined,
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
    account: (moving.chosen ?? current)?.id,
    models,
    providers: pickerProviders(models, statuses.data ?? []),
    catalog,
  };
  return (
    <>
      <ModelControl
        view={view}
        className={chipControl}
        compact={compact}
        actions={{
          onEffort: (next) => change({ effort: next }),
          onFast: (on) => change({ serviceTier: on ? speed.tier : speed.off }),
          onReset: () => change({ effort: undefined, serviceTier: undefined }),
          onModel: (key, instance) => {
            const from = moving.chosen ?? current;
            const choice = choiceForModel(choices, key, instance ?? from?.accountId);
            if (!choice || choice.id === from?.id) return true;
            const provider = moving.chosen?.provider ?? selection?.provider ?? meta?.provider;
            if (meta && choice.provider !== provider) {
              setAsking(choice);
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
      {asking && meta && (
        <SwitchDialog
          from={moving.chosen?.provider ?? selection?.provider ?? meta.provider}
          to={asking}
          busy={props.busy}
          onConfirm={() => switchTo(asking)}
          onClose={() => setAsking(undefined)}
        />
      )}
    </>
  );
}
