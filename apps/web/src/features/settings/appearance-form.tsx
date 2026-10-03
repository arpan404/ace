import { useForm } from "@tanstack/react-form";
import { z } from "zod";
import { Button } from "@/components/ui/button.tsx";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { usePreferences } from "@/lib/preferences-context.tsx";
import { Density, Theme } from "@/lib/preferences.ts";

const AppearanceValues = z.object({ theme: Theme, density: Density });

const themes: { value: Theme; label: string }[] = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const densities: { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

/** TanStack Form with a Zod schema; values are local device preferences. */
export function AppearanceForm() {
  const { preferences, update } = usePreferences();
  const form = useForm({
    defaultValues: { theme: preferences.theme, density: preferences.density },
    validators: { onChange: AppearanceValues },
    onSubmit: ({ value }) => update(AppearanceValues.parse(value)),
  });
  return (
    <form
      aria-label="Appearance"
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="theme">
        {(field) => (
          <Choice
            legend="Theme"
            name={field.name}
            options={themes}
            value={field.state.value}
            onChange={(value) => field.handleChange(Theme.parse(value))}
          />
        )}
      </form.Field>
      <form.Field name="density">
        {(field) => (
          <Choice
            legend="Transcript density"
            name={field.name}
            options={densities}
            value={field.state.value}
            onChange={(value) => field.handleChange(Density.parse(value))}
          />
        )}
      </form.Field>
      <form.Subscribe selector={(state) => [state.canSubmit, state.isDirty] as const}>
        {([canSubmit, isDirty]) => (
          <Button type="submit" className="self-start" disabled={!canSubmit || !isDirty}>
            Save appearance
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

function Choice<T extends string>(props: {
  legend: string;
  name: string;
  options: { value: T; label: string }[];
  value: T;
  onChange(value: unknown): void;
}) {
  return (
    <FieldSet>
      <FieldLegend>{props.legend}</FieldLegend>
      <RadioGroup name={props.name} value={props.value} onValueChange={props.onChange}>
        {props.options.map((option) => (
          <Field key={option.value} orientation="horizontal">
            <RadioGroupItem value={option.value} id={`${props.name}-${option.value}`} />
            <FieldLabel htmlFor={`${props.name}-${option.value}`}>{option.label}</FieldLabel>
          </Field>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}
