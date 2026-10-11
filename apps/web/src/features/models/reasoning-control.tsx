import { effortLabel } from "@ace/ui-core";
import { CaretDownIcon } from "@phosphor-icons/react";
import { Suspense, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import type { ModelControlActions, ModelControlView } from "./control-view.ts";
import { reasoningShortLabel } from "./reasoning-level.ts";

const DeferredEffortPopover = deferredComponent(() =>
  import("./effort-popover.tsx").then((module) => module.EffortPopover),
);
const warm = () => void DeferredEffortPopover.preload();

/** Effort is chosen independently of the model, using the catalog's actual levels. */
export function ReasoningControl(props: {
  view: ModelControlView;
  className: string;
  actions: ModelControlActions;
  onModels(): void;
}) {
  const [open, setOpen] = useState(false);
  const { effort, effortDefault, effortReason } = props.view;
  const label =
    effort === undefined
      ? "Select effort"
      : `${effortLabel(effort)} reasoning${effortDefault ? " · default" : ""}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label={effortReason ?? label}>
        <PopoverTrigger
          aria-label={`Reasoning: ${effort === undefined ? "Select effort" : effortLabel(effort)}`}
          disabled={props.view.disabled}
          onPointerEnter={warm}
          onFocus={warm}
          className={cn(props.className, "shrink-0 font-normal focus-ring-inset")}
        >
          <span role="img" aria-label={label}>
            {effort === undefined ? "Select effort" : reasoningShortLabel(effort)}
          </span>
          <CaretDownIcon aria-hidden size={12} />
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        side={props.view.side ?? "top"}
        align="start"
        aria-label="Effort and speed"
        className="overflow-hidden p-0 motion-reduce:transition-none"
      >
        <Suspense
          fallback={
            <div className="grid h-28 w-72 place-items-center">
              <Spinner label="Loading effort" />
            </div>
          }
        >
          <DeferredEffortPopover.Component
            view={props.view}
            actions={props.actions}
            onModels={() => {
              setOpen(false);
              props.onModels();
            }}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
