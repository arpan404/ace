import { Button } from "@/components/ui/button.tsx";
import type { DeviceProblem, useDevices } from "./use-devices.ts";

type Devices = ReturnType<typeof useDevices>;

const permissionNames = { screenRecording: "Screen Recording", accessibility: "Accessibility" };

/**
 * macOS hasn't given ace's screen helper a permission it needs: say which, where to turn it on,
 * and offer to open that pane (on the Mac running ace) and to try again.
 */
export function PermissionGuide(props: {
  problem: DeviceProblem & { permission: keyof typeof permissionNames };
  devices: Devices;
  pending: boolean;
  /** Inline above a live screen rather than in its place. */
  compact?: boolean;
}) {
  const { problem, devices } = props;
  const name = permissionNames[problem.permission];
  return (
    <div
      role="alert"
      aria-label={`${name} permission needed`}
      className={
        props.compact
          ? "flex shrink-0 flex-col gap-2 px-3 py-2.5"
          : "grid min-h-40 flex-1 place-items-center px-4"
      }
    >
      <div className="flex max-w-sm flex-col gap-2.5">
        <p className="text-sm font-medium text-foreground">{problem.message}</p>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Open System Settings › Privacy &amp; Security › {name}.</li>
          <li>
            Turn on <span className="text-foreground">Ace Screen Helper</span>.
          </li>
          <li>Come back here and try again.</li>
        </ol>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={props.pending}
            onClick={() => devices.grant(problem.permission)}
          >
            Open {name} settings
          </Button>
          {!props.compact && (
            <Button size="sm" variant="outline" disabled={props.pending} onClick={devices.retry}>
              Try again
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function needsPermission(
  problem: DeviceProblem | undefined,
): problem is DeviceProblem & { permission: keyof typeof permissionNames } {
  return problem?.permission !== undefined;
}
