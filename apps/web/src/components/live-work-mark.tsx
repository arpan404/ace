import { useLiveConnection } from "@/lib/live-connection.ts";
import { Dot } from "./ui/dot.tsx";
import { Spinner } from "./ui/spinner.tsx";

/** A provider's work mark stops moving while its last facts are stale. */
export function LiveWorkMark(props: { label?: string; className?: string }) {
  const live = useLiveConnection();
  return live.fresh ? (
    <Spinner {...props} />
  ) : (
    <Dot
      tone="limited"
      label={live.staleLabel ?? "Activity paused"}
      {...(props.className ? { className: props.className } : {})}
    />
  );
}
