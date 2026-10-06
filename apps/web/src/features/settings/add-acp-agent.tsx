import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { DisabledReason } from "./setting-control.tsx";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";

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

/** "Any ACP agent › Add": a name and the command that speaks ACP over stdio. */
export function AddAcpAgent() {
  const [open, setOpen] = useState(false);
  const backend = useSettingsBackend();
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: (agent: z.infer<typeof AcpAgent>) => backend.addAcpAgent(agent),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: settingsQueries.providers(backend).queryKey,
      });
      setOpen(false);
    },
  });
  const form = useForm({
    defaultValues: { name: "", command: "" },
    validators: { onSubmit: AcpAgent },
    onSubmit: async ({ value, formApi }) => {
      await add.mutateAsync(AcpAgent.parse(value));
      formApi.reset();
    },
  });
  if (!backend.canAddAcpAgent)
    return (
      <DisabledReason reason="Needs a newer daemon">
        <Button size="sm" disabled>
          Add
        </Button>
      </DisabledReason>
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}>
        Add
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an ACP agent</DialogTitle>
          <DialogDescription>
            ace starts the command on this machine and talks to it over the Agent Client Protocol.
            It uses the agent's own login.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          aria-label="Add an ACP agent"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="name">
            {(field) => (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="acp-name" className="text-ui font-medium">
                  Name
                </label>
                <Input
                  id="acp-name"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="Gemini CLI"
                  aria-invalid={field.state.meta.errors.length > 0}
                />
                <FieldError errors={field.state.meta.errors} />
              </div>
            )}
          </form.Field>
          <form.Field name="command">
            {(field) => (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="acp-command" className="text-ui font-medium">
                  Command
                </label>
                <Input
                  id="acp-command"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="gemini --experimental-acp"
                  spellCheck={false}
                  className="font-mono text-[12.5px]"
                  aria-invalid={field.state.meta.errors.length > 0}
                />
                <FieldError errors={field.state.meta.errors} />
              </div>
            )}
          </form.Field>
          {add.isError && (
            <p role="alert" className="text-sm text-destructive">
              {add.error.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={add.isPending}>
              Add agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FieldError(props: { errors: readonly unknown[] }) {
  const text = message(props.errors);
  return text ? (
    <span role="alert" className="text-sm text-destructive">
      {text}
    </span>
  ) : null;
}
