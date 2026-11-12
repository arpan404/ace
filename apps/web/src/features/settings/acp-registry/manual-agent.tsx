import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button.tsx";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { settingsQueries, useSettingsBackend } from "../data/use-settings.ts";

const AcpAgent = z.object({
  name: z.string().trim().min(1, "Give the agent a name.").max(64),
  command: z.string().trim().min(1, "Enter the command that starts the agent.").max(512),
});

function message(errors: readonly unknown[]): string | undefined {
  const first = errors[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "message" in first)
    return typeof first.message === "string" ? first.message : undefined;
  return undefined;
}

/**
 * The fallback for an agent the registry doesn't list, as a dialog's content: a name and the
 * command that speaks ACP over stdio. ace starts it on the computer running ace; it uses the
 * agent's own login.
 */
export function ManualAgent(props: { onCancel(): void; onAdded(): void }) {
  const backend = useSettingsBackend();
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: (agent: z.infer<typeof AcpAgent>) => backend.addAcpAgent(agent),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: settingsQueries.providers(backend).queryKey,
      });
      props.onAdded();
    },
  });
  const form = useForm({
    defaultValues: { name: "", command: "" },
    validators: { onSubmit: AcpAgent },
    onSubmit: async ({ value }) => {
      await add.mutateAsync(AcpAgent.parse(value));
    },
  });
  return (
    <form
      noValidate
      aria-label="Add an ACP agent by command"
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Add an agent by command</DialogTitle>
        <DialogDescription>
          For an agent the registry doesn't list. ace starts the command on the computer running ace
          and talks to it over the Agent Client Protocol, with the agent's own login.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4 py-4">
        <form.Field name="name">
          {(field) => (
            <Field label="Name" id="acp-name" errors={field.state.meta.errors}>
              <Input
                id="acp-name"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                placeholder="Gemini CLI"
                aria-invalid={field.state.meta.errors.length > 0}
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="command">
          {(field) => (
            <Field label="Command" id="acp-command" errors={field.state.meta.errors}>
              <Input
                id="acp-command"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                placeholder="gemini --experimental-acp"
                spellCheck={false}
                className="font-mono text-sm"
                aria-invalid={field.state.meta.errors.length > 0}
              />
            </Field>
          )}
        </form.Field>
        {add.isError && (
          <p role="alert" className="text-sm text-destructive">
            {add.error.message}
          </p>
        )}
      </div>
      <DialogFooter>
        {!backend.canAddAcpAgent && (
          <span className="mr-auto min-w-0 truncate text-sm text-muted-foreground">
            This daemon can't add agents by command yet.
          </span>
        )}
        <Button type="button" variant="secondary" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!backend.canAddAcpAgent || add.isPending}>
          Add agent
        </Button>
      </DialogFooter>
    </form>
  );
}

function Field(props: {
  label: string;
  id: string;
  errors: readonly unknown[];
  children: React.ReactNode;
}) {
  const text = message(props.errors);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.id} className="text-ui font-medium">
        {props.label}
      </label>
      {props.children}
      {text && (
        <span role="alert" className="text-sm text-destructive">
          {text}
        </span>
      )}
    </div>
  );
}
