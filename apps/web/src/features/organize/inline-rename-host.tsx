import { deferredComponent } from "@/lib/deferred-component.tsx";
import { Suspense } from "react";
import type { InlineRenameProps } from "./inline-rename.tsx";

const InlineRename = deferredComponent(() =>
  import("./inline-rename.tsx").then((module) => module.InlineRename),
);
/** The shared field loads when a thread title is edited. */
export function InlineRenameField(props: InlineRenameProps) {
  return (
    <Suspense fallback={null}>
      <InlineRename.Component {...props} />
    </Suspense>
  );
}
