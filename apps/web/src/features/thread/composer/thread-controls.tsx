import { useConnectionState, useThreadMeta } from "@ace/client-react";
import type { AccessMode, ExecutionOptions } from "@ace/protocol";
import {
  accessChoices,
  accountDisplayName,
  formatClock,
  choiceForModel,
  currentModelChoice,
  modelControlName,
  nextOptions,
  optionEffort,
  permissionPendingNote,
  pickerModelsFromChoices,
  pickerProviders,
  providerNames,
  reconcileNextOptions,
  recordedChoice,
  resolveEffort,
  speedControl,
  speedOption,
  selectionInputs,
  choiceSelection,
  switchUnsupportedNote,
  threadSwitchRoute,
  threadAccessSummary,
  threadEffortControl,
  unavailablePickerModel,
  unavailableModelNotice,
  type ModelChoice,
} from "@ace/ui-core";
import { useEffect, useRef, useState } from "react";
import { useThreadModelAvailability } from "../lib/model-availability.ts";
import { useThreadToast } from "../lib/thread-toast.ts";
import { useAccountViews } from "@/lib/account-views.ts";
import { useToast } from "@/components/ui/toast.tsx";
import {
  ModelControl,
  useModelCatalogState,
  useModelChoices,
  type ModelControlView,
} from "@/features/models/index.ts";
import { failureMessage } from "@/lib/daemon-command.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import type { ThreadRef } from "../sources/index.ts";
import { SwitchDialog } from "../transitions/switch-dialog.tsx";
import { useComposerCompact } from "./composer-compact.ts";
import { chipControl } from "./composer-styles.ts";
import { selectionIdentity, type PendingTurn } from "./execution.ts";
import { useModelSwitch } from "./use-model-switch.ts";
import { continuationAttachmentProblem, continuationNote } from "./continue-in-thread.ts";
import { readDraft } from "./draft-store.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useAccessModes, useThreadPermission } from "./permission-hooks.ts";
import { PermissionPicker } from "./permission-picker.tsx";

/** Access changes stay pending until the harness runs the new mode. */
export function ThreadPermissionControl(props: { thread: ThreadRef }) {
  const meta = useThreadMeta(props.thread.id);
  const toast = useToast();
  const permission = useThreadPermission(props.thread.id, meta?.permission);
  const [daemonDefault] = useDaemonSetting("access.defaultMode");
  const projectDefault = useProjectDirectory().projects.find(
    (project) => project.id === props.thread.workspaceId,
  )?.defaults?.access;
  const change = (mode: AccessMode | null) =>
    void permission
      .change(mode)
      .catch((error: unknown) =>
        toast.error({ title: "Couldn't change access", description: failureMessage(error) }),
      );
  const { offers, loading, failed } = useAccessModes(
    meta?.provider,
    (meta?.effectiveCapabilities ?? meta?.capabilities)?.accessModes,
  );
  const summary = threadAccessSummary(meta?.permission, offers, {
    chosen: permission.chosen,
    defaultMode: projectDefault ?? daemonDefault,
    provider: meta ? providerNames[meta.provider] : undefined,
  });
  return (
    <PermissionPicker
      summary={summary}
      note={summary?.next ? (permission.note ?? permissionPendingNote()) : undefined}
      menu={{
        choices: accessChoices(offers),
        value: summary?.next ?? summary?.mode ?? undefined,
        loading: loading || (!meta?.permission && !failed),
        unavailable: failed
          ? "Couldn't load this thread's access. Reconnect and try again."
          : summary?.custom
            ? "Set by a native mode in Settings → Providers."
            : undefined,
      }}
      onChange={change}
    />
  );
}

/** Offline, changes still go: effort and speed with the next message, a switch from the outbox. */
const offlineNote = "Offline: changes apply when reconnected";
const limitReached = (resetsAt: number | undefined) =>
  resetsAt === undefined ? "Limit reached" : `Limit reached · resets ${formatClock(resetsAt)}`;
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
 * A model this thread can't move to in place (a Cursor thread leaving Cursor or its account):
 * picked here, it waits in the composer and the next message starts a new thread on it.
 */
export interface ContinuedTurn {
  choice: ModelChoice | undefined;
  onChange(choice: ModelChoice | undefined): void;
}

/**
 * The thread's model, account, effort and speed. Another model or account continues the thread
 * from its next turn (another provider asks first, since the agent's private state stays
 * behind). Effort and speed go with the next message, where the provider takes them as session
 * options. They belong to the selection they were picked for: when the thread moves (here, or
 * from another device), what the new model doesn't take is reset, and the person is told.
 */
export function ThreadModelControl(props: {
  thread: ThreadRef;
  busy: boolean;
  next: NextTurn;
  /** A model the thread continues on in a new thread, held by the composer until it sends. */
  continued?: ContinuedTurn | undefined;
  pickerRequest?: number;
  tuneRequest?: number;
}) {
  const meta = useThreadMeta(props.thread.id);
  const toast = useThreadToast(props.thread.id);
  const accounts = useAccountViews();
  const choices = useModelChoices();
  const catalog = useModelCatalogState();
  const statuses = useProviderStatuses();
  const compact = useComposerCompact();
  const [asking, setAsking] = useState<ModelChoice>();
  const moving = useModelSwitch(props.thread, meta, choices);
  const online = useConnectionState() === "ready";
  const { selection, unavailable } = useThreadModelAvailability(props.thread.id);
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
  const preset = resolveEffort(shown?.efforts ?? [], undefined, shown?.defaultEffort);
  const effort = threadEffortControl({
    choice: shown,
    capabilities: meta?.capabilities,
    current: optionEffort(options),
  });
  const speed = speedControl({
    model: shown && {
      label: shown.model,
      provider: shown.provider,
      speeds: shown.speeds,
      defaultSpeed: shown.defaultSpeed,
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
      speeds: shown.speeds,
      speedAllowed: speed.reason === undefined,
    });
    props.next.onChange(kept && { identity: selectionKey, options: kept });
    if (dropped.length)
      toast.add({
        title: `${dropped.map((word, at) => (at ? word : droppedWords[word])).join(" and ")} reset for ${shown.model}`,
        description: "What you picked doesn't apply to the model the thread runs on now.",
      });
  });
  const continuedTo = props.continued?.choice;
  const { storage } = useLayout();
  const catalogModels = useModelCatalog();
  // Files in the message being written that the new thread's model can't take, said in the
  // confirmation; the send checks again with what the message holds then.
  const carryProblem = (choice: ModelChoice) =>
    continuationAttachmentProblem(
      readDraft(storage, `thread:${props.thread.id}`)?.attachments ?? [],
      choice,
      catalogModels && selectionInputs(catalogModels, choiceSelection(choice)),
    );
  const routeOf = (choice: ModelChoice) => (meta ? threadSwitchRoute(meta, choice) : "in_place");
  const switchTo = (choice: ModelChoice) => {
    setAsking(undefined);
    props.continued?.onChange(undefined);
    // The chip shows the new model at once. Effort and speed picked for the old one stay until
    // the switch lands; then they're checked against the new model (a refused switch takes the
    // choice back and keeps them as they were).
    moving.switchTo(choice).then(
      () =>
        toast.add({
          title:
            choice.accountId !== shown?.accountId
              ? `Next turn runs on ${providerNames[choice.provider]} · ${choice.account}`
              : props.busy
                ? `Next turn runs on ${choice.model}`
                : `Continues on ${choice.model}`,
        }),
      (error: unknown) =>
        toast.error({ title: "Couldn't switch the model", description: failureMessage(error) }),
    );
  };
  // What the chip names: a new thread's model, the switch just chosen here, else what the thread
  // runs on next.
  const target = continuedTo ?? moving.chosen ?? shown;
  const account = target?.account ? accountDisplayName(target.account) : undefined;
  const details = {
    model: target?.model ?? "",
    account,
    effort: effort.current,
    effortDefault: !effort.reported,
    hasEfforts: effort.efforts.length > 0,
    speed: speed.speed,
  };
  const name = target && modelControlName(details);
  const waiting = pending
    ? "applies with your next message"
    : !effort.reported && effort.current !== undefined
      ? "Reasoning preset applies at the next turn; the running turn has not reported its level"
      : undefined;
  const switchWaits = continuedTo
    ? {
        from: shown && shown.model !== continuedTo.model ? shown.model : undefined,
        description: continuationNote,
      }
    : moving.waiting(target);
  // Models this thread can't move to say so in the picker, before anything is sent.
  const unsupported = new Set(
    choices.filter((choice) => routeOf(choice) === "unsupported").map((choice) => choice.key),
  );
  const listed = pickerModelsFromChoices(choices, limitReached);
  for (const model of listed)
    if (unsupported.has(model.key)) model.unavailable ??= switchUnsupportedNote;
  const models = listed.filter(
    (model) =>
      !unavailable ||
      model.key !== (current?.key ?? `${unavailable.provider}\u0000${unavailable.model}`) ||
      (unavailable.instance && model.instance !== unavailable.instance),
  );
  if (unavailable)
    models.unshift(
      unavailablePickerModel({
        provider: unavailable.provider,
        model: current?.modelId ?? unavailable.model,
        instanceId: unavailable.instance,
      }),
    );
  const view: ModelControlView = {
    unavailable: unavailable && unavailableModelNotice(unavailable),
    pickerRequest: props.pickerRequest,
    tuneRequest: props.tuneRequest,
    provider: target?.provider,
    label: target?.model,
    accountLabel:
      (accounts.data?.filter((entry) => entry.provider === target?.provider).length ?? 0) > 1
        ? account
        : undefined,
    placeholder: "Model",
    ariaLabel: name ? `Model: ${name}${unavailable ? ", Unavailable" : ""}` : "Choose a model",
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
    effort: effort.current,
    defaultEffort: preset,
    effortDefault: !effort.reported,
    effortReason: effort.reason,
    speeds: speed.tiers,
    speed: speed.speed,
    speedReason: speed.reason,
    canReset: optionEffort(options) !== undefined && optionEffort(options) !== preset,
    accounts: shown?.account
      ? choices
          .filter((choice) => choice.key === shown.key && choice.account)
          .map((choice) => ({
            id: choice.id,
            label: accountDisplayName(choice.account),
            detail: choice.note,
            authMethod: accounts.data?.find((entry) => entry.id === choice.accountId)?.authMethod,
            disabled: choice.exhausted ? limitReached(choice.resetsAt) : undefined,
          }))
      : [],
    account: (continuedTo ?? moving.chosen ?? current)?.id,
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
          // Back to the default: where the thread's own selection names an effort, the
          // provider keeps it unless told otherwise, so the default goes out by name.
          onEffort: (next) =>
            change({
              effort: next ?? (optionEffort(base) === undefined ? undefined : preset),
            }),
          onSpeed: (next) => change({ serviceTier: speedOption(speed.tiers, next) }),
          onModel: (key, instance) => {
            const from = continuedTo ?? moving.chosen ?? current;
            const choice = choiceForModel(choices, key, instance ?? from?.accountId);
            if (!choice || choice.id === from?.id) return true;
            const route = routeOf(choice);
            if (route === "unsupported") return false;
            // Back to what the thread runs on: the new thread is no longer wanted.
            if (continuedTo && choice.id === current?.id) {
              props.continued?.onChange(undefined);
              return true;
            }
            const provider = moving.chosen?.provider ?? selection?.provider ?? meta?.provider;
            if (route === "new_thread" || (meta && choice.provider !== provider)) {
              setAsking(choice);
              return false;
            }
            switchTo(choice);
            return true;
          },
          onAccount: (id) => {
            const choice = choices.find((candidate) => candidate.id === id);
            if (!choice) return;
            if (continuedTo && choice.id === current?.id) props.continued?.onChange(undefined);
            else if (routeOf(choice) === "new_thread") setAsking(choice);
            else switchTo(choice);
          },
        }}
      />
      {asking && meta && (
        <SwitchDialog
          from={moving.chosen?.provider ?? selection?.provider ?? meta.provider}
          to={asking}
          busy={props.busy}
          continues={routeOf(asking) === "new_thread"}
          warning={routeOf(asking) === "new_thread" ? carryProblem(asking) : undefined}
          onConfirm={() => {
            if (routeOf(asking) !== "new_thread") return switchTo(asking);
            setAsking(undefined);
            props.continued?.onChange(asking);
          }}
          onClose={() => setAsking(undefined)}
        />
      )}
    </>
  );
}
