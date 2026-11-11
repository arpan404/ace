import { WorkspaceId, type OutsideProjects, type OutsideScope } from "@ace/protocol";
import { outsideLifetimes, outsideTicks, type OutsideLifetime } from "@ace/ui-core/outside-clients";
import { useId, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { useRegisteredProjects } from "@/lib/projects.ts";

/*
 * What a grant may do, where, and for how long: the approval dialog and a grant's own page
 * share these. Plain rows under a heading, no boxes.
 */

function Heading(props: { children: ReactNode; id?: string }) {
  return (
    <h3 id={props.id} className="text-ui font-medium text-foreground">
      {props.children}
    </h3>
  );
}

function Tick(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  /** Quiet words after the label ("asked for", "always"). */
  note?: string | undefined;
  onChange?: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-8 items-center gap-2.5">
      <Checkbox
        id={id}
        checked={props.checked}
        disabled={props.disabled ?? false}
        onCheckedChange={(checked) => props.onChange?.(checked)}
      />
      <label htmlFor={id} className="min-w-0 flex-1 text-ui text-foreground">
        {props.label}
      </label>
      {props.note && <span className="text-xs text-subtle-foreground">{props.note}</span>}
    </div>
  );
}

/** Read is fixed on; each other scope is its own tick. `asked` marks what the client wants. */
export function AccessTicks(props: {
  scopes: ReadonlySet<OutsideScope>;
  asked?: ReadonlySet<OutsideScope> | undefined;
  onChange(scopes: ReadonlySet<OutsideScope>): void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <Heading id={id}>Access</Heading>
      <Tick label="Read threads" checked disabled note="always" />
      {outsideTicks.map((tick) => (
        <Tick
          key={tick.scope}
          label={tick.label}
          checked={props.scopes.has(tick.scope)}
          note={props.asked?.has(tick.scope) ? "asked for" : undefined}
          onChange={(checked) => {
            const next = new Set(props.scopes);
            if (checked) next.add(tick.scope);
            else next.delete(tick.scope);
            props.onChange(next);
          }}
        />
      ))}
    </section>
  );
}

/** Every project, or chosen ones from the machine's own list. */
export function ProjectsChoice(props: {
  projects: OutsideProjects;
  onChange(projects: OutsideProjects): void;
}) {
  const id = useId();
  const registered = useRegisteredProjects();
  const { name } = registered;
  // Ids from the machine's own list, read as the protocol's project ids.
  const ids = registered.ids.flatMap((raw) => {
    const parsed = WorkspaceId.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  const chosen: ReadonlySet<string> | undefined =
    props.projects === "all" ? undefined : new Set(props.projects);
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <Heading id={id}>Projects</Heading>
        <SegmentedControl
          label="Projects"
          size="sm"
          value={chosen ? "chosen" : "all"}
          options={[
            { value: "all", label: "All" },
            { value: "chosen", label: "Chosen" },
          ]}
          onValueChange={(value) => {
            if (value === "all") props.onChange("all");
            else if (!chosen) {
              const first = ids[0];
              // A grant always names at least one project; with none listed, it stays on all.
              if (first) props.onChange([first]);
            }
          }}
        />
      </div>
      {chosen && (
        <div className="flex max-h-48 flex-col overflow-y-auto">
          {ids.map((project) => (
            <Tick
              key={project}
              label={name(project)}
              checked={chosen.has(project)}
              onChange={(checked) => {
                const next = ids.filter((each) => (each === project ? checked : chosen.has(each)));
                if (next.length) props.onChange(next);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** How long the grant lasts. An unset value presses nothing (a grant keeping its end). */
export function LifetimeChoice(props: {
  value: OutsideLifetime | undefined;
  /** Shown beside the heading: when the grant ends now ("Expires in 12 days"). */
  current?: string | undefined;
  onChange(lifetime: OutsideLifetime): void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-h-8 items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <Heading id={id}>How long</Heading>
        {props.current && <span className="text-xs text-muted-foreground">{props.current}</span>}
      </div>
      <SegmentedControl<OutsideLifetime | "keep">
        label="How long"
        size="sm"
        value={props.value ?? "keep"}
        options={outsideLifetimes}
        onValueChange={(value) => value !== "keep" && props.onChange(value)}
      />
    </section>
  );
}
