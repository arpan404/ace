import { CopyIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";

/** A shell command as a chip that never wraps inside, with a copy button beside it. */
export function CopyCommand(props: { command: string }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.command);
      toast.add({ title: "Copied" });
    } catch {
      toast.error({ title: "Couldn't copy. Select the command and copy it yourself." });
    }
  };
  return (
    <span className="inline-flex items-center gap-0.5 align-middle whitespace-nowrap">
      <code className="rounded-xs bg-secondary px-1 font-mono text-sm text-foreground">
        {props.command}
      </code>
      <IconButton
        icon={CopyIcon}
        label="Copy command"
        size="sm"
        type="button"
        onClick={() => void copy()}
      />
    </span>
  );
}
