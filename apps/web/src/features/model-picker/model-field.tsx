import type { ProviderKind } from "@ace/protocol";
import type { PickerModel } from "@ace/ui-core";
import { CaretDownIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { cn } from "@/lib/cn.ts";
import { useModelCatalogState } from "@/lib/model-catalog.ts";
import { ModelPickerPanel } from "./model-picker-panel.tsx";

export interface ModelFieldProps {
  /** The field's accessible name, "Model". */
  label: string;
  provider: ProviderKind;
  models: readonly PickerModel[];
  /** The chosen model's key, and its account when the row names one. */
  current: string | undefined;
  currentInstance?: string | undefined;
  /** What the field reads: the model's name, or what stands in until one is known. */
  value: string;
  /** Quiet text after the name: "Default", "Your choice". */
  note?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  onPick(key: string, instance: string | undefined): void;
}

/**
 * One provider's model as a form field (Settings' default model, an automation's model): the
 * model's name with a quiet note ("Default"), opening the same picker as the composer's chip,
 * limited to that provider: its source groups, Legacy models, errors and Refresh models.
 */
export function ModelField(props: ModelFieldProps) {
  const [open, setOpen] = useState(false);
  const catalog = useModelCatalogState();
  const unavailable = props.models.some(
    (model) => model.key === props.current && model.unavailable,
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`${props.label}: ${[props.value, props.note].filter(Boolean).join(", ")}`}
        disabled={props.disabled}
        className={cn(
          "inline-flex h-8 min-w-0 items-center gap-2 rounded-md bg-secondary pr-2 pl-2.5 text-ui text-foreground transition-[background-color,box-shadow] duration-(--dur-1) focus-ring touch-hit disabled:opacity-50",
          props.className,
        )}
      >
        <span className="min-w-0 truncate">{props.value}</span>
        {props.note && (
          <span
            className={cn(
              "shrink-0 text-xs",
              unavailable ? "text-status-failed" : "text-subtle-foreground",
            )}
          >
            {props.note}
          </span>
        )}
        <CaretDownIcon aria-hidden size={12} className="ml-auto shrink-0 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverContent aria-label={props.label} className="overflow-hidden p-0">
        <ModelPickerPanel
          models={props.models}
          providers={[{ provider: props.provider, reason: undefined }]}
          current={props.current}
          currentInstance={props.currentInstance}
          currentProvider={props.provider}
          catalog={catalog}
          only={props.provider}
          onPick={(key, instance) => {
            setOpen(false);
            props.onPick(key, instance);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
