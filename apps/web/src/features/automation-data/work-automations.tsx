import { useNavigate } from "@tanstack/react-router";
import { nextRunText, localTimeZone } from "@ace/ui-core/automations";
import { pluralCount } from "@ace/ui-core";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useNow } from "@/lib/time.ts";
import { useAutomations } from "./use-automations.ts";

/**
 * The project's schedules, read with the same query as Automations: `entries` once read,
 * `failed` when the read failed (with `retry`). Undefined entries while it reads.
 */
export function useProjectAutomations(workspaceId: string, workspacePath: string | undefined) {
  const query = useAutomations();
  const entries = query.data?.filter(
    ({ automation }) =>
      automation.trigger.kind === "schedule" &&
      (automation.workspace === workspaceId || automation.workspace === workspacePath),
  );
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
        Couldn't read automations. Try again
      </button>
    );
  if (!entries?.length) return null;
  const next = entries
    .filter((entry) => entry.automation.enabled && entry.nextRunAt !== undefined)
    .toSorted((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0))[0];
  const when = next
    ? nextRunText(next.automation, next.nextRunAt, now, localTimeZone(), running)
    : undefined;
  const line = [
    `${pluralCount(entries.length, "automation")} in this project`,
    when && `next ${when.charAt(0).toLowerCase()}${when.slice(1)}`,
  ]
    .filter(Boolean)
    .join(" · ");
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
