import { catalogDisplayName } from "@ace/ui-core";
import type { CatalogEntry, CatalogMention } from "@ace/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Input } from "@/components/ui/input.tsx";
export function CommandArguments(props: {
  entry: CatalogEntry;
  onAccept(values: NonNullable<CatalogMention["values"]>): void;
  onClose(): void;
}) {
  const parameters =
    props.entry.invocation.type === "prompt" ? (props.entry.invocation.parameters ?? {}) : {};
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(parameters).map(([name, parameter]) => [
        name,
        String(parameter.default ?? ""),
      ]),
    ),
  );
  const [error, setError] = useState<string>();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed: NonNullable<CatalogMention["values"]> = {};
            for (const [name, parameter] of Object.entries(parameters)) {
              const value = values[name] ?? "";
              if (!value && parameter.required) return setError(`Enter ${name} to continue.`);
              if (!value) continue;
              if (parameter.type === "number" && !Number.isFinite(Number(value)))
                return setError(`Enter a number for ${name}.`);
              parsed[name] =
                parameter.type === "number"
                  ? Number(value)
                  : parameter.type === "boolean"
                    ? value === "true"
                    : value;
            }
            props.onAccept(parsed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{catalogDisplayName(props.entry)}</DialogTitle>
            <DialogDescription>
              {props.entry.description || "Fill in the command's arguments."}
            </DialogDescription>
          </DialogHeader>
          {Object.entries(parameters).map(([name, parameter]) => (
            <label key={name} className="flex flex-col gap-1.5 text-ui">
              {name}
              {parameter.required ? " (required)" : ""}
              {parameter.type === "boolean" ? (
                <Select
                  label={name}
                  value={values[name] ?? ""}
                  options={[
                    { value: "", label: "Use default" },
                    { value: "true", label: "Yes" },
                    { value: "false", label: "No" },
                  ]}
                  onValueChange={(value) => setValues({ ...values, [name]: value })}
                />
              ) : (
                <Input
                  aria-label={name}
                  type={parameter.type === "number" ? "number" : "text"}
                  required={parameter.required}
                  value={values[name]}
                  onChange={(event) => setValues({ ...values, [name]: event.target.value })}
                />
              )}
            </label>
          ))}
          {error && (
            <p role="alert" className="text-ui text-status-failed">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Add command
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
