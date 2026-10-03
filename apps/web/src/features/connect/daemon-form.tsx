import { useForm } from "@tanstack/react-form";
import { z } from "zod";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { DaemonToken, DaemonUrl, type DaemonTarget } from "@/boot/connection-settings.ts";

const FormValues = z.object({ url: DaemonUrl, token: DaemonToken, remember: z.boolean() });

function firstError(errors: readonly unknown[]): string | undefined {
  for (const error of errors) {
    if (typeof error === "string") return error;
    if (
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
    )
      return error.message;
  }
  return undefined;
}

/** Address + token + "remember", validated with the same schemas the gate parses with. */
export function DaemonForm(props: {
  url: string;
  remembered: boolean;
  submitLabel: string;
  onSubmit(target: DaemonTarget, remember: boolean): void;
}) {
  const form = useForm({
    defaultValues: { url: props.url, token: "", remember: props.remembered },
    validators: { onSubmit: FormValues },
    onSubmit: ({ value }) => {
      const parsed = FormValues.parse(value);
      props.onSubmit({ url: parsed.url, token: parsed.token }, parsed.remember);
    },
  });
  return (
    <form
      aria-label="Daemon connection"
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="url">
        {(field) => (
          <FieldRow
            id="daemon-url"
            label="Daemon address"
            error={firstError(field.state.meta.errors)}
          >
            <Input
              id="daemon-url"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[12.5px]"
            />
          </FieldRow>
        )}
      </form.Field>
      <form.Field name="token">
        {(field) => (
          <FieldRow
            id="daemon-token"
            label="Token"
            hint={
              <>
                On the machine running the daemon: <code>cat ~/.ace/daemon-token</code>
              </>
            }
            error={firstError(field.state.meta.errors)}
          >
            <Input
              id="daemon-token"
              type="password"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
              spellCheck={false}
              autoComplete="off"
              placeholder="64 hexadecimal characters"
              className="font-mono text-[12.5px]"
            />
          </FieldRow>
        )}
      </form.Field>
      <form.Field name="remember">
        {(field) => (
          <label className="flex items-center justify-between gap-4 text-ui">
            <span>
              Remember on this device
              <span className="block text-sm text-muted-foreground">
                Otherwise the token is forgotten when this window closes.
              </span>
            </span>
            <Switch
              checked={field.state.value}
              onCheckedChange={(checked) => field.handleChange(checked)}
            />
          </label>
        )}
      </form.Field>
      <Button type="submit" variant="primary" className="self-start">
        {props.submitLabel}
      </Button>
    </form>
  );
}

function FieldRow(props: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.id} className="text-ui font-medium">
        {props.label}
      </label>
      {props.children}
      {props.error ? (
        <p role="alert" className="text-sm text-destructive">
          {props.error}
        </p>
      ) : (
        props.hint && (
          <p className="text-sm text-muted-foreground [&_code]:rounded-[5px] [&_code]:bg-secondary [&_code]:px-1 [&_code]:text-[12px]">
            {props.hint}
          </p>
        )
      )}
    </div>
  );
}
