import { useForm } from "@tanstack/react-form";
import { AutomationForm } from "./automation-values.ts";

/** TanStack Form over the automation schema, validated on every change. */
export function useAutomationForm(
  initial: AutomationForm,
  onSave: (form: AutomationForm) => Promise<void>,
) {
  return useForm({
    defaultValues: initial,
    validators: { onChange: AutomationForm },
    onSubmit: ({ value }) => onSave(AutomationForm.parse(value)),
  });
}

export type AutomationFormApi = ReturnType<typeof useAutomationForm>;
