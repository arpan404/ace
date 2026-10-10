import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import type { PrLinksDialog as LoadedDialog } from "./header/pr-links-dialog.tsx";
const Dialog = lazy(() =>
  import("./header/pr-links-dialog.tsx").then((module) => ({ default: module.PrLinksDialog })),
);
export function PrLinksDialog(props: ComponentProps<typeof LoadedDialog>) {
  return (
    <Suspense fallback={null}>
      <Dialog {...props} />
    </Suspense>
  );
}
