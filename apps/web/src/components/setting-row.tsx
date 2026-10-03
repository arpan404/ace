import type { ReactNode } from "react";

/**
 * Settings-style row: title and description on the left, the control on the right, hairlines
 * between rows. Used by Settings, Automations, Skills and account pages.
 */
export function SettingRow(props: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Associates the title with a control for assistive tech. */
  htmlFor?: string;
}) {
  const Title = props.htmlFor ? "label" : "div";
  return (
    <div className="flex items-center gap-4 border-t py-3.5 last:border-b">
      <div className="min-w-0 flex-1">
        <Title
          {...(props.htmlFor ? { htmlFor: props.htmlFor } : {})}
          className="block text-[13.5px] font-medium"
        >
          {props.title}
        </Title>
        {props.description && (
          <p className="mt-0.5 max-w-[46ch] text-sm leading-[1.4] text-muted-foreground">
            {props.description}
          </p>
        )}
      </div>
      {props.children && (
        <div className="ml-auto flex shrink-0 items-center gap-2">{props.children}</div>
      )}
    </div>
  );
}

/** A labelled group of rows. */
export function SettingSection(props: { label: string; children: ReactNode }) {
  return (
    <section className="mt-7" aria-label={props.label}>
      <h3 className="mb-2.5 text-[12px] font-medium tracking-[0.01em] text-subtle-foreground">
        {props.label}
      </h3>
      {props.children}
    </section>
  );
}
