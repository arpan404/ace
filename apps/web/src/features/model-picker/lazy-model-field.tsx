import { Suspense } from "react";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import type { ModelFieldProps } from "./model-field.tsx";

/** The field and its picker load after the form has painted, so its route carries neither. */
const Deferred = deferredComponent(() =>
  import("./model-field.tsx").then((module) => module.ModelField),
);

/** `ModelField`, with a control of its size standing in while its code arrives. */
export function LazyModelField(props: ModelFieldProps) {
  return (
    <Suspense
      fallback={
        <span
          aria-hidden
          className={cn("inline-block h-8 rounded-md bg-secondary", props.className)}
        />
      }
    >
      <Deferred.Component {...props} />
    </Suspense>
  );
}
