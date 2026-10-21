import { useAgent } from "@ace/client-react";
import type { DeviceActivity } from "@ace/protocol";
import { useEffect, useRef, useState } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { activityCaption, screenFraction, type Size } from "@ace/ui-core/devices";

/** How long a caption stays before it fades. */
const captionMs = 2000;
/** The exit fade's length (`--motion-exit`), before the caption unmounts. */
const exitMs = 140;

export interface ShownActivity {
  activity: DeviceActivity;
  leaving: boolean;
}

/**
 * The agent's newest action while it is fresh: each sequence shows once, for about two seconds,
 * then fades. What was already there when the view opened isn't replayed.
 */
export function useFreshActivity(activity: DeviceActivity | undefined): ShownActivity | undefined {
  const seen = useRef<number | undefined>(activity?.sequence);
  const latest = useRef(activity);
  // Runs before the effect below in the same commit, so it reads this render's activity.
  useEffect(() => {
    latest.current = activity;
  });
  const [shown, setShown] = useState<ShownActivity>();
  const sequence = activity?.sequence;
  useEffect(() => {
    const fresh = latest.current;
    if (sequence === undefined || !fresh || sequence === seen.current) return;
    seen.current = sequence;
    setShown({ activity: fresh, leaving: false });
    const fade = setTimeout(
      () => setShown((current) => current && { ...current, leaving: true }),
      captionMs,
    );
    const clear = setTimeout(() => setShown(undefined), captionMs + exitMs);
    return () => {
      clearTimeout(fade);
      clearTimeout(clear);
    };
  }, [sequence]);
  return shown;
}

/** The agent's tap as a ring that grows and fades where it landed, over the screen. */
export function ActivityRipple(props: { shown: ShownActivity | undefined; screen: Size }) {
  const point = props.shown?.activity.point;
  const at = point && screenFraction(point, props.screen);
  if (!props.shown || !at) return null;
  const style = { left: `${at.x * 100}%`, top: `${at.y * 100}%` };
  return (
    <span key={props.shown.activity.sequence} aria-hidden data-activity-ripple="">
      <span
        className="fx-tap-ripple pointer-events-none absolute -mt-7 -ml-7 size-14 rounded-full border-2 border-status-working bg-status-working/20"
        style={style}
      />
      {/* The point itself stays a moment longer than the ring. */}
      <span
        className="pointer-events-none absolute -mt-1.5 -ml-1.5 size-3 rounded-full bg-status-working shadow-(--depth-raise) transition-opacity duration-(--motion-exit)"
        style={{ ...style, opacity: props.shown.leaving ? 0 : 1 }}
      />
    </span>
  );
}

/** "tap @e7 “Sign in”" with the agent's mark, in a pill at the bottom of the stage. */
export function ActivityCaption(props: {
  shown: ShownActivity | undefined;
  holder: { threadId: string; agentId: string } | undefined;
}) {
  const agent = useAgent(props.holder?.threadId ?? "", props.holder?.agentId ?? "");
  if (!props.shown) return null;
  return (
    <p
      role="status"
      aria-label="Agent action"
      className={`${props.shown.leaving ? "fx-float-out" : "fx-float-in"} ace-floating inline-flex h-7 max-w-full items-center gap-1.5 rounded-full px-3 text-xs text-foreground`}
    >
      {agent && (
        <ProviderIcon
          provider={agent.native.provider}
          acpAgentId={agent.native.acpAgentId}
          model={agent.model}
          size={12}
          decorative
        />
      )}
      <span className="truncate">{activityCaption(props.shown.activity)}</span>
    </p>
  );
}
