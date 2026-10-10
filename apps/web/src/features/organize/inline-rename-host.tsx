import { lazy, Suspense } from "react";
import type { InlineRenameProps } from "./inline-rename.tsx";

const InlineRename = lazy(() =>
  import("./inline-rename.tsx").then((module) => ({ default: module.InlineRename })),
);
/** The shared field loads when a thread title is edited. */
export function InlineRenameField(props: InlineRenameProps) {
  return (
    <Suspense fallback={null}>
      <InlineRename {...props} />
    </Suspense>
  );
}
