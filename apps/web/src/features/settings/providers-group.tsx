import { useId, type ReactNode } from "react";
import { SettingCard, settingsGroup } from "@/components/setting-row.tsx";

/**
 * A Providers group: its heading with a quiet aside on the same line (a count, where the list
 * comes from) and at most one control at the right, above the rounded group of rows.
 */
export function ProvidersGroup(props: {
  label: string;
  aside?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={settingsGroup} aria-labelledby={id}>
      <div className="mb-1.5 flex min-h-7 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 id={id} className="text-base font-semibold text-foreground">
          {props.label}
        </h3>
        {props.aside && (
          <span className="min-w-0 truncate text-xs text-subtle-foreground tabular-nums">
            {props.aside}
          </span>
        )}
        {props.actions && (
          <div className="ml-auto flex items-center gap-2 [&>[data-variant=ghost]:last-child]:-mr-2.5">
            {props.actions}
          </div>
        )}
      </div>
      <SettingCard>{props.children}</SettingCard>
    </section>
  );
}
