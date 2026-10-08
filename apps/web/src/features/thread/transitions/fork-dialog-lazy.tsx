import { Suspense, type ComponentProps } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";

const DeferredFork = deferredComponent(() =>
  import("./fork-dialog.tsx").then((module) => module.ForkDialog),
);

/** The sidebar loads the fork form and its model picker only when a fork is requested. */
export function ForkDialog(props: ComponentProps<typeof import("./fork-dialog.tsx").ForkDialog>) {
  return (
    <Suspense fallback={null}>
      <DeferredFork.Component {...props} />
    </Suspense>
  );
}
