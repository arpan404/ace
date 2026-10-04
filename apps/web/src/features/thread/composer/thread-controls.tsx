import { useThreadMeta } from "@ace/client-react";
import { WorkspaceId, type PermissionMode, type Thread } from "@ace/protocol";
import {
  choiceSelection,
  currentModelChoice,
  optionEffort,
  permissionLabel,
  threadEffortControl,
  threadPermissionSummary,
  type ModelChoice,
} from "@ace/ui-core";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useModelChoices } from "@/features/models/index.ts";
import { failureMessage } from "@/lib/daemon-command.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { SwitchDialog } from "../transitions/switch-dialog.tsx";
import { ModelPicker } from "./model-picker.tsx";
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

/**
 * The thread's model, account and effort. Another model or account continues the thread from
 * its next turn (another provider asks first, since the agent's private state stays behind);
 * effort changes the same way where the provider takes it as a session option.
 */
export function ThreadModelControl(props: { thread: ThreadRef; busy: boolean }) {
  const meta = useThreadMeta(props.thread.id);
  const sources = useThreadSources();
  const toast = useToast();
  const choices = useModelChoices();
  const [switching, setSwitching] = useState<ModelChoice>();
  const selection = runsOn(meta);
  const current = currentModelChoice(choices, selection);
  const effort = threadEffortControl({
    choice: current,
    capabilities: meta?.capabilities,
    current: optionEffort(selection?.options),
  });
  const switchTo = (choice: ModelChoice) => {
    setSwitching(undefined);
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
  const setEffort = (next: string) => {
    if (!current || next === effort.current) return;
    sources.actions
      .switchTo(props.thread, {
        ...choiceSelection(current),
        options: { ...selection?.options, effort: next },
      })
      .then(
        () =>
          toast.add({
            title: props.busy ? `${next} effort from the next turn` : `Continues at ${next} effort`,
          }),
        (error: unknown) =>
          toast.add({ title: "Couldn't change the effort", description: failureMessage(error) }),
      );
  };
  return (
    <>
      <ModelPicker
        choices={choices}
        value={current}
        effort={effort}
        onChange={(choice) => {
          if (choice.id === current?.id) return;
          if (meta && choice.provider !== (selection?.provider ?? meta.provider))
            setSwitching(choice);
          else switchTo(choice);
        }}
        onEffort={setEffort}
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

/** The thread composer's footer controls: approvals, then model, account and effort. */
export function ThreadControls(props: { thread: ThreadRef; busy: boolean }) {
  return (
    <>
      <ThreadPermissionControl thread={props.thread} />
      <ThreadModelControl thread={props.thread} busy={props.busy} />
    </>
  );
}
