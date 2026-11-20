import { SpadeHelperLine } from "./spade-helper-line.tsx";

/**
 * A call the bot made to another of the person's bots' contracts (ADR 0200 §7): one plain line
 * in Spade's words ("Asked Flight watcher: cheapest_fare"), timed while it is open, and what came
 * back under it in quieter words. Words only: no icon, no badge, no tint.
 */
export function SpadeContractLine(props: {
  text: string;
  result: string;
  open: boolean;
  since?: number | undefined;
}) {
  return (
    <div className="min-w-0">
      <SpadeHelperLine text={props.text} open={props.open} since={props.since} />
      {!props.open && props.result && (
        <p className="-mt-1 ml-1.5 min-w-0 truncate px-2 text-ui text-subtle-foreground">
          {props.result}
        </p>
      )}
    </div>
  );
}
