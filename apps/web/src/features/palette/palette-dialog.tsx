import { Suspense, useCallback, useState } from "react";
import { CommandDialog } from "@/components/ui/command.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { AddProjectSteps, isAddPage } from "@/features/projects/index.ts";
import type { PalettePage, PaletteStart } from "@/lib/layout.tsx";
import { NewThreadIn } from "./new-thread-in.tsx";
import PaletteBody from "./palette-body.tsx";

/**
 * The ⌘K sheet as one lazily loaded chunk: the search, and the steps it opens in place (Add
 * project and its sources, New thread in…). Steps stack; Back (or Backspace in an empty field)
 * returns to the one before, and the search is under them all.
 */
export default function PaletteDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  close(): void;
  start: PaletteStart;
}) {
  const [stack, setStack] = useState<PalettePage[]>([]);
  // Every opening starts over, on the step it was opened on.
  const [startedWith, setStartedWith] = useState<PaletteStart>();
  if (startedWith !== props.start) {
    setStartedWith(props.start);
    setStack(props.start.page ? [props.start.page] : []);
  }
  const page = stack.at(-1);
  const push = useCallback((next: PalettePage) => setStack((pages) => [...pages, next]), []);
  const back = useCallback(() => setStack((pages) => pages.slice(0, -1)), []);
  const title = isAddPage(page)
    ? "Add project"
    : page === "new-thread-in"
      ? "New thread in"
      : "Command palette";
  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange} title={title}>
      {props.open &&
        (page === undefined ? (
          <PaletteBody close={props.close} push={push} />
        ) : page === "new-thread-in" ? (
          <NewThreadIn onBack={back} close={props.close} onAddProject={() => push("add-project")} />
        ) : (
          <Suspense fallback={<ListSkeleton label="Add project" shape="row" rows={4} />}>
            <AddProjectSteps.Component
              page={page}
              attempt={page === props.start.page ? props.start.attempt : undefined}
              clone={page === props.start.page ? props.start.clone : undefined}
              onPage={push}
              onBack={back}
              close={props.close}
            />
          </Suspense>
        ))}
    </CommandDialog>
  );
}
