import type { Automation } from "@ace/protocol";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import {
  composerEnvironmentRow,
  composerEnvironmentSurface,
  composerStrip,
} from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { localTimeZone } from "@/features/automation-schedule/index.ts";
import { AutomationForm, automationFromForm, formFromAutomation } from "./automation-values.ts";
import { fieldErrors, WhenPopover } from "./when-popover.tsx";

/**
 * The conversation composer's strip, as on a new automation: when it runs and whether it gets a
 * worktree, changed in place. The When popover edits a copy and saves it as it closes; a copy
 * that doesn't check out isn't saved, and says why.
 */
export function WhenStrip(props: {
  automation: Automation;
  onSave(next: Automation): void;
  open: boolean;
  onOpenChange(open: boolean): void;
  returnFocus(): HTMLElement | null;
  disabled?: boolean;
}) {
  const toast = useToast();
  const [form, setForm] = useState(() => formFromAutomation(props.automation, localTimeZone()));
  const openChange = (open: boolean) => {
    if (open) setForm(formFromAutomation(props.automation, localTimeZone()));
    else commit();
    props.onOpenChange(open);
  };
  const commit = () => {
    const before = formFromAutomation(props.automation, localTimeZone());
    if (JSON.stringify(form) === JSON.stringify(before)) return;
    const parsed = AutomationForm.safeParse(form);
    if (!parsed.success) {
      toast.error({
        title: `Not saved: ${parsed.error.issues[0]?.message ?? "check when it runs."}`,
      });
      return;
    }
    props.onSave(
      automationFromForm(parsed.data, {
        id: props.automation.id,
        now: Date.now(),
        previous: props.automation,
      }),
    );
  };
  return (
    <div className={composerEnvironmentSurface}>
      <div className={composerEnvironmentRow}>
        <section
          aria-label="When and where it runs"
          className="flex min-w-0 flex-1 items-center gap-0.5 text-xs text-muted-foreground"
        >
          <WhenPopover
            form={props.open ? form : formFromAutomation(props.automation, localTimeZone())}
            onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
            errors={fieldErrors(form)}
            open={props.open}
            onOpenChange={openChange}
            returnFocus={props.returnFocus}
          />
          <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
          <label className={cn(composerStrip, "shrink-0 cursor-default")}>
            <span>Worktree</span>
            <Checkbox
              checked={props.automation.worktree}
              disabled={props.disabled}
              onCheckedChange={(worktree) => props.onSave({ ...props.automation, worktree })}
            />
          </label>
        </section>
      </div>
    </div>
  );
}
