import type { ReviewSource } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";

/**
 * Some reads failed while others answered: one line under the bar naming the projects or
 * repositories that failed, with the way to ask again. The rows shown are the ones that answered.
 */
export function PartialNotice(props: {
  failed: readonly ReviewSource[];
  name(source: ReviewSource): string;
  onRetry(): void;
}) {
  if (!props.failed.length) return null;
  const names = [...new Set(props.failed.map(props.name))];
  const repositories = props.failed.every((source) => source.shown);
  const said =
    names.length <= 2
      ? names.join(" and ")
      : `${names.length} ${repositories ? "repositories" : "projects"}`;
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

/**
 * Projects whose repositories couldn't be read list only their primary: one sentence saying
 * which, so a list that may be missing repositories never looks complete.
 */
export function UnlistedNotice(props: {
  projects: readonly string[];
  name(project: string): string;
}) {
  if (!props.projects.length) return null;
  const names = props.projects.map(props.name);
  const said = names.length <= 2 ? names.join(" and ") : `${names.length} projects`;
  return (
    <div
      role="status"
      className="flex min-h-9 min-w-0 items-center gap-1 border-t border-border py-1 text-ui text-muted-foreground"
    >
      <span className="min-w-0 truncate" title={names.join(", ")}>
        {`Couldn't read the repositories of ${said}, so only ${names.length === 1 ? "its primary is" : "their primaries are"} listed.`}
      </span>
    </div>
  );
}
