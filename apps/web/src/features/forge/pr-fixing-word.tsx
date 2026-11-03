import { useFixingNow } from "./pr-fix-marks.ts";

/** "Agent fixing this" beside a row a Fix with agent request came from, while its agent works. */
export function PrFixingWord(props: { subject: string }) {
  if (!useFixingNow(props.subject)) return null;
  return (
    <>
      <span aria-hidden>·</span>
      <span className="shrink-0 text-status-working">Agent fixing this</span>
    </>
  );
}
