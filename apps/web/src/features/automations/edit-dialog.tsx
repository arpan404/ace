import type { Automation } from "@ace/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { localTimeZone } from "@/features/automation-schedule/index.ts";
import { useNow } from "@/lib/time.ts";
import { AutomationForm, automationFromForm, formFromAutomation } from "@ace/ui-core/automations";
import { fieldErrors, WhenFields } from "./when-popover.tsx";

/**
 * Everything about an automation in one dialog: its name, the message it sends, when it sends
 * it. It closes once the daemon has the change.
 */
export function EditDialog(props: {
  open: boolean;
  automation: Automation;
  onClose(): void;
  onSave(next: Automation): Promise<boolean>;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-lg">{props.open && <EditForm {...props} />}</DialogContent>
    </Dialog>
  );
}

function EditForm(props: {
  automation: Automation;
  onClose(): void;
  onSave(next: Automation): Promise<boolean>;
}) {
  const now = useNow();
  const [initial] = useState(() => formFromAutomation(props.automation, localTimeZone()));
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState<ReadonlySet<keyof AutomationForm>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const all = fieldErrors(form);
  const errors = Object.fromEntries(
    Object.entries(all).filter(([field]) => showAll || touched.has(field as keyof AutomationForm)),
  );
  const changed = JSON.stringify(form) !== JSON.stringify(initial);
  const change = (patch: Partial<AutomationForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setTouched(
      (current) => new Set([...current, ...(Object.keys(patch) as (keyof AutomationForm)[])]),
    );
  };
  const submit = () => {
    if (saving || !changed) return;
    const parsed = AutomationForm.safeParse({
      ...form,
      title: form.title.trim(),
      prompt: form.prompt.trim(),
    });
    if (!parsed.success) return setShowAll(true);
    setSaving(true);
    const next = automationFromForm(parsed.data, {
      id: props.automation.id,
      now: Date.now(),
      previous: props.automation,
    });
    void props.onSave(next).then((saved) => {
      setSaving(false);
      if (saved) props.onClose();
    });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Edit automation</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-ui text-muted-foreground">Name</span>
          <Input
            name="title"
            maxLength={256}
            value={form.title}
            onValueChange={(title) => change({ title })}
            aria-invalid={errors.title ? true : undefined}
          />
          {errors.title && <span className="text-xs text-destructive">{errors.title}</span>}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ui text-muted-foreground">Message</span>
          <Textarea
            name="prompt"
            value={form.prompt}
            onChange={(event) => change({ prompt: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
            className="min-h-24"
            aria-invalid={errors.prompt ? true : undefined}
          />
          {errors.prompt && <span className="text-xs text-destructive">{errors.prompt}</span>}
        </label>
        <section
          aria-label="When it runs"
          className="-mx-2 flex flex-col border-t border-border pt-2"
        >
          <WhenFields form={form} onChange={change} errors={errors} now={now} />
        </section>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!changed || saving}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
