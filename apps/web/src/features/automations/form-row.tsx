import type { ReactNode } from "react";

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

export function Row(props: {
  label: string;
  htmlFor?: string;
  errors?: string | undefined;
  children: ReactNode;
}) {
  const Label = props.htmlFor ? "label" : "span";
  return (
    <div className="mb-4 flex flex-col gap-1.5">
      <Label
        {...(props.htmlFor ? { htmlFor: props.htmlFor } : {})}
        className="text-[12.5px] font-medium text-muted-foreground"
      >
        {props.label}
      </Label>
      {props.children}
      {props.errors && (
        <p role="alert" className="text-sm text-destructive">
          {props.errors}
        </p>
      )}
    </div>
  );
}
