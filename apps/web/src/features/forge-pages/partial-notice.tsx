import { Button } from "@/components/ui/button.tsx";

/**
 * Some projects' reads failed while others answered: one line under the bar naming them, with
 * the way to ask again. The rows shown are the projects that answered.
 */
export function PartialNotice(props: {
  failed: readonly string[];
  name(id: string): string;
  onRetry(): void;
}) {
  if (!props.failed.length) return null;
  const names = props.failed.map(props.name);
  const said = names.length <= 2 ? names.join(" and ") : `${names.length} projects`;
  return (
    <div
      role="status"
      className="flex min-h-9 min-w-0 items-center gap-1 border-t border-border py-1 text-ui text-muted-foreground"
    >
      <span className="min-w-0 truncate" title={names.join(", ")}>
        {`Couldn't load ${said}.`}
      </span>
      <Button size="xs" variant="ghost" className="text-foreground" onClick={props.onRetry}>
        Try again
      </Button>
    </div>
  );
}
