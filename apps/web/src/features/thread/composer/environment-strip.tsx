import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { useThreadMeta } from "@ace/client-react";
import { CaretDownIcon, GitBranchIcon, GitForkIcon } from "@phosphor-icons/react";
import { Suspense, useId, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useCheckout } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { environmentSurface, stripControl, environmentRow } from "./composer-styles.ts";
import { ComposerSettingsControls } from "./composer-settings.tsx";

const DeferredThreadEnvironment = deferredComponent(() =>
  import("./thread-environment.tsx").then((module) => module.ThreadEnvironmentCard),
);

/** Branch and machine below the box, always available alongside requests, plans and Stop. */
export function EnvironmentStrip(props: { thread: ThreadRef; onClose(): void }) {
  const checkout = useCheckout(props.thread);
  const host = useMachineIdentity(useThreadMeta(props.thread.id)?.details?.machine);
  const [open, setOpen] = useState(false);
  const controls = useId();
  const worktree = checkout?.mode === "worktree";
  const branch = checkout?.branch ?? "detached HEAD";
  const Place = worktree ? GitForkIcon : GitBranchIcon;
  const close = () => {
    setOpen(false);
    props.onClose();
  };
  return (
    <section aria-label="Environment" className={environmentSurface}>
      <div className={environmentRow}>
        {checkout && (
          <Popover open={open} onOpenChange={setOpen}>
            <Tip label="Where this thread runs" side="top">
              <PopoverTrigger
                aria-label={`Environment: ${worktree ? "Worktree" : "Local"} · ${branch}`}
                aria-controls={controls}
                className={cn(stripControl, "min-w-0 max-w-full flex-1 justify-start")}
              >
                <Place aria-hidden size={14} className="shrink-0" />
                <span className="min-w-0 truncate">{branch}</span>
                {host && (
                  <>
                    <span aria-hidden className="text-subtle-foreground">
                      ·
                    </span>
                    <MachineLabel name={host.name} icon={host.icon} />
                  </>
                )}
                <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
              </PopoverTrigger>
            </Tip>
            <PopoverContent
              side="top"
              align="start"
              className="max-h-[50vh] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain"
              finalFocus={false}
            >
              <Suspense fallback={null}>
                <DeferredThreadEnvironment.Component
                  thread={props.thread}
                  id={controls}
                  onClose={close}
                />
              </Suspense>
            </PopoverContent>
          </Popover>
        )}
        <ComposerSettingsControls />
      </div>
    </section>
  );
}
