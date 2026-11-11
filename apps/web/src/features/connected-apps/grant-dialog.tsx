import type { ClientApi } from "@ace/client";
import { useSidebarThread } from "@ace/client-react";
import type { OutsideGrantEntry, OutsideProjects, OutsideScope } from "@ace/protocol";
import {
  clientDomainWords,
  expiryWords,
  lifetimeEnd,
  outsideTicks,
  type OutsideLifetime,
} from "@ace/ui-core/outside-clients";
import { formatAgo } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { threadOn } from "@/lib/machine-routes.ts";
import { useClock, useNow } from "@/lib/time.ts";
import { AccessTicks, LifetimeChoice, ProjectsChoice } from "./access-fields.tsx";
import type { GrantChange } from "./data/outside.ts";

const sameProjects = (a: OutsideProjects, b: OutsideProjects) =>
  a === "all" || b === "all" ? a === b : a.length === b.length && a.every((id) => b.includes(id));

/** The scopes a grant keeps after the person's ticks: read first, then the ticks in order. */
function scopesOf(ticked: ReadonlySet<OutsideScope>): OutsideScope[] {
  return ["threads:read", ...outsideTicks.map((tick) => tick.scope).filter((s) => ticked.has(s))];
}

/**
 * One live grant: the threads it started and messaged (each opens the thread), what it may do,
 * where and for how long, and Revoke. Save sends only what changed.
 */
export function GrantDialog(props: {
  grant: OutsideGrantEntry;
  /** The machine's id in links; undefined for this window's own machine. */
  machineId: string | undefined;
  client: ClientApi;
  onSave(change: GrantChange): Promise<void>;
  onRevoke(): void;
  onClose(): void;
}) {
  const { grant } = props;
  const now = useNow();
  const clock = useClock();
  const [scopes, setScopes] = useState<ReadonlySet<OutsideScope>>(() => new Set(grant.scopes));
  const [projects, setProjects] = useState<OutsideProjects>(grant.projects);
  const [lifetime, setLifetime] = useState<OutsideLifetime>();
  const [pending, setPending] = useState(false);
  const nextScopes = scopesOf(scopes);
  const scopesChanged = nextScopes.join() !== scopesOf(new Set(grant.scopes)).join();
  const projectsChanged = !sameProjects(projects, grant.projects);
  const changed = scopesChanged || projectsChanged || lifetime !== undefined;
  /** What Save sends, the new end read from the clock as it is pressed. */
  const change = (): GrantChange => ({
    ...(scopesChanged ? { scopes: nextScopes } : {}),
    ...(projectsChanged ? { projects } : {}),
    ...(lifetime ? { expiresAt: lifetimeEnd(lifetime, clock()) } : {}),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{grant.name}</DialogTitle>
          <DialogDescription>
            {clientDomainWords(grant.domain)} ·{" "}
            {grant.lastUsedAt === null
              ? "not used yet"
              : `used ${formatAgo(grant.lastUsedAt, now)}`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <GrantThreads title="Started" ids={grant.started} machineId={props.machineId} />
          <GrantThreads title="Messaged" ids={grant.messaged} machineId={props.machineId} />
          <AccessTicks scopes={scopes} onChange={setScopes} />
          <ProjectsChoice projects={projects} onChange={setProjects} />
          <LifetimeChoice
            value={lifetime}
            current={expiryWords(grant.expiresAt, now)}
            onChange={setLifetime}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" tone="danger" className="mr-auto" onClick={props.onRevoke}>
            Revoke
          </Button>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!changed || pending}
            onClick={() => {
              setPending(true);
              void props
                .onSave(change())
                .then(props.onClose, () => {})
                .finally(() => setPending(false));
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GrantThreads(props: {
  title: string;
  ids: readonly string[];
  machineId: string | undefined;
}) {
  const id = useId();
  if (!props.ids.length) return null;
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <h3 id={id} className="text-ui font-medium text-foreground">
        {props.title}
      </h3>
      {props.ids.slice(0, 20).map((threadId) => (
        <ThreadLink key={threadId} threadId={threadId} machineId={props.machineId} />
      ))}
      {props.ids.length > 20 && (
        <span className="text-xs text-muted-foreground">{props.ids.length - 20} more</span>
      )}
    </section>
  );
}

function ThreadLink(props: { threadId: string; machineId: string | undefined }) {
  const thread = useSidebarThread(props.threadId);
  return (
    <Link
      {...threadOn(props.machineId, props.threadId)}
      className="flex min-h-8 items-center truncate rounded-sm text-ui text-link focus-ring hover:underline"
    >
      {thread?.title ?? "A thread"}
    </Link>
  );
}
