import type { LiveVideoStatus, MediaAcceleration } from "@ace/protocol";
import { liveVideoSentence } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";

/*
 * ADR 0148, decision 8: a live view carries one sentence, and only while its source is degraded
 * (its video encode isn't on hardware, or a step the probe found hardware for runs on the CPU).
 * ace-media writes that sentence as the reason; a source degraded without one gets a plain
 * default. Nothing else: no icon, badge, tint or timer.
 */

const fallback = "Video runs on the processor here.";

/** The sentence a live view shows, exactly while `degraded` is true. */
export function degradedSentence(acceleration: MediaAcceleration | undefined): string | undefined {
  if (acceleration?.degraded !== true) return undefined;
  const reason = acceleration.reason?.trim();
  if (!reason) return fallback;
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

/** The sentence as a status line of muted text; nothing while the source isn't degraded. */
export function DegradedLine(props: {
  acceleration: MediaAcceleration | undefined;
  className?: string;
}) {
  const sentence = degradedSentence(props.acceleration);
  if (!sentence) return null;
  return (
    <p role="status" className={cn("text-xs text-muted-foreground", props.className)}>
      {sentence}
    </p>
  );
}

/**
 * A screen's or device's live video that can't play now says why (X2), in the same muted status
 * line; it takes the degraded sentence's place while it lasts, since nothing plays to degrade.
 */
export function VideoStatusLine(props: {
  video: LiveVideoStatus | undefined;
  acceleration: MediaAcceleration | undefined;
  className?: string;
}) {
  const sentence = liveVideoSentence(props.video);
  if (!sentence)
    return (
      <DegradedLine
        acceleration={props.acceleration}
        {...(props.className ? { className: props.className } : {})}
      />
    );
  return (
    <p role="status" className={cn("text-xs text-muted-foreground", props.className)}>
      {sentence}
    </p>
  );
}
