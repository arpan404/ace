import { CaretLeftIcon } from "@ace/icons";
import { Link } from "@tanstack/react-router";
import { part } from "@/lib/suit-part.ts";

/** The way back to Fleet from a page inside it, or to a machine from one of its own pages. */
export function FleetBack(props: { machine?: { id: string; name: string } }) {
  const { machine } = props;
  const className =
    "inline-flex items-center gap-1 rounded-xs text-muted-foreground focus-ring hover:text-foreground";
  const caret = <CaretLeftIcon aria-hidden size={12} />;
  if (machine)
    return (
      <Link
        to="/settings/remote/$machine"
        params={{ machine: machine.id }}
        aria-label={`Back to ${machine.name}`}
        {...part("link", undefined, "back")}
        className={className}
      >
        {caret}
        {machine.name}
      </Link>
    );
  return (
    <Link
      to="/settings/remote"
      aria-label="Back to Fleet"
      {...part("link", undefined, "back")}
      className={className}
    >
      {caret}
      Fleet
    </Link>
  );
}
