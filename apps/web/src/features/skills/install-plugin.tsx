import { PlusIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { PluginRepository, pluginName, useInstallPlugin } from "./skills-source.ts";

/** "+" in the Skills header: install a plugin from a repository. */
export function InstallPlugin() {
  const [open, setOpen] = useState(false);
  const [repository, setRepository] = useState("");
  const [error, setError] = useState<string>();
  const install = useInstallPlugin();
  const toast = useToast();
  const navigate = useNavigate();
  const id = useId();
  const submit = async () => {
    const parsed = PluginRepository.safeParse(repository);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    try {
      await install.mutateAsync(parsed.data);
      const name = pluginName(parsed.data);
      setOpen(false);
      setRepository("");
      setError(undefined);
      toast.add({ title: `Installed ${name}` });
      await navigate({ to: "/skills/$skillId", params: { skillId: name } });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The plugin didn't install.");
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<IconButton icon={PlusIcon} label="Add skill or plugin" />} />
      <DialogContent>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Install a plugin</DialogTitle>
            <DialogDescription>
              Skills load from <code>.claude/skills</code> in a repo or your home folder. Plugins
              install from a repository; ace shows what they run before they are enabled.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor={id} className="text-sm font-medium text-muted-foreground">
              Repository
            </label>
            <Input
              id={id}
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              placeholder="getsentry/sentry-mcp"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              className="font-mono text-[12.5px]"
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" variant="primary" disabled={install.isPending}>
              Install
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
