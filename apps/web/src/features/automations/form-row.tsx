import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/** Errors once the person has touched the field or tried to save. */
export function visible(meta: {
  isTouched: boolean;
  errors: readonly unknown[];
}): string | undefined {
  if (!meta.isTouched) return undefined;
  for (const error of meta.errors) {
    if (typeof error === "string") return error;
    if (
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
    )
      return error.message;
  }
  return undefined;
}

const errorId = (id: string) => `${id}-error`;

/**
 * Ties a control to its row's error: `aria-invalid`, and the message as its description, so
 * focusing the control (as a failed save does) reads the problem out.
 */
export function invalidProps(id: string, error: string | undefined) {
  return error ? { "aria-invalid": true, "aria-describedby": errorId(id) } : {};
}

/**
 * A labelled field. The error sits under the control with an id the control points at
 * (`invalidProps`); it isn't a live region, so typing doesn't re-announce it.
 */
export function Row(props: {
  label: string;
  htmlFor?: string;
  errors?: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  const Label = props.htmlFor ? "label" : "span";
  return (
    <div className={cn("mb-4 flex min-w-0 flex-col items-stretch gap-1.5", props.className)}>
      <Label
        {...(props.htmlFor ? { htmlFor: props.htmlFor } : {})}
        className="text-sm font-medium text-muted-foreground"
      >
        {props.label}
      </Label>
      {props.children}
      {props.errors && (
        <p
          {...(props.htmlFor ? { id: errorId(props.htmlFor) } : {})}
          className="text-sm text-destructive"
        >
          {props.errors}
        </p>
      )}
    </div>
  );
}
