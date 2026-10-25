import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { sectionRule } from "@/components/ui/rules.ts";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { cn } from "@/lib/cn.ts";

export interface SkillDraft {
  description: string;
  body: string;
  manual: boolean;
}

/**
 * A skill's description, instructions and Runs as one form. The name stays as it is. A save
 * refused because the file changed meanwhile says so, and Reload brings the new text in.
 */
export function SkillEditForm(props: {
  initial: SkillDraft;
  saving: boolean;
  conflict: boolean;
  error: string | undefined;
  onSave(draft: SkillDraft): void;
  onCancel(): void;
  onReload(): void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const ids = { description: useId(), body: useId() };
  const change = (patch: Partial<SkillDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const unchanged =
    draft.description === props.initial.description &&
    draft.body === props.initial.body &&
    draft.manual === props.initial.manual;
  return (
    <form
      aria-label="Edit skill"
      className="mt-8 flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unchanged && draft.description.trim())
          props.onSave({ ...draft, description: draft.description.trim() });
      }}
    >
      <div className="flex flex-col">
        <label htmlFor={ids.description} className="mb-1.5 text-ui font-medium">
          Description
        </label>
        <Input
          id={ids.description}
          value={draft.description}
          readOnly={props.saving}
          onValueChange={(value: string) => change({ description: value })}
        />
      </div>
      <div className="flex flex-col">
        <label htmlFor={ids.body} className="mb-1.5 text-ui font-medium">
          Instructions
        </label>
        <Textarea
          id={ids.body}
          value={draft.body}
          readOnly={props.saving}
          spellCheck={false}
          onChange={(event) => change({ body: event.target.value })}
          className="max-h-none min-h-80 font-mono text-sm"
        />
      </div>
      <div className="flex flex-col">
        <span className="mb-1.5 text-ui font-medium">Runs</span>
        <SegmentedControl
          label="Runs"
          value={draft.manual ? "manual" : "auto"}
          disabled={props.saving}
          options={[
            { value: "auto", label: "When it fits" },
            { value: "manual", label: "Only when picked" },
          ]}
          onValueChange={(value) => change({ manual: value === "manual" })}
          className="w-fit"
        />
      </div>
      {(props.conflict || props.error) && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          {props.conflict ? "This skill changed since you opened it." : props.error}
          {props.conflict && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                props.onReload();
              }}
            >
              Reload
            </Button>
          )}
        </p>
      )}
      <div className={cn(sectionRule, "flex justify-end gap-2 pt-4")}>
        <Button variant="ghost" disabled={props.saving} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={props.saving || unchanged || !draft.description.trim()}
        >
          {props.saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
