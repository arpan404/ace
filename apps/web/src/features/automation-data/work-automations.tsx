import { useNavigate } from "@tanstack/react-router";
import {
  localTimeZone,
  projectAutomationsFailed,
  projectAutomationsLine,
  projectSchedules,
} from "@ace/ui-core/automations";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useNow } from "@/lib/time.ts";
import { useAutomations } from "./use-automations.ts";

/**
 * The project's schedules, read with the same query as Automations: `entries` once read,
 * `failed` when the read failed (with `retry`). Undefined entries while it reads.
 */
export function useProjectAutomations(workspaceId: string, workspacePath: string | undefined) {
  const query = useAutomations();
  const entries = query.data && projectSchedules(query.data, workspaceId, workspacePath);
  return { entries, failed: query.isError, retry: () => void query.refetch() };
}

/**
 * The project's schedules in one quiet line at the foot of the Summary ("2 automations in this
 * project · next tonight 2:00"), opening Automations. A project with none shows nothing.
 */
export function WorkAutomationsLine(props: {
  automations: ReturnType<typeof useProjectAutomations>;
}) {
  const navigate = useNavigate();
  const now = useNow();
  const [running] = useDaemonSetting("automations.enabled");
  const { entries, failed, retry } = props.automations;
  if (failed)
    return (
      <button
        type="button"
        onClick={retry}
        data-tone="failed"
        className="focus-ring-inset mx-2 rounded-sm text-left text-xs text-(--tone-text)"
      >
        {projectAutomationsFailed}
      </button>
    );
  const line =
    entries && projectAutomationsLine(entries, { now, localZone: localTimeZone(), running });
  if (!line) return null;
  return (
    <button
      type="button"
      aria-label={`${line}. Open automations`}
      onClick={() => void navigate({ to: "/automations" })}
      className="focus-ring-inset mx-2 truncate rounded-sm text-left text-xs text-subtle-foreground hover:text-foreground"
    >
      {line}
    </button>
  );
}
