import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";

/** A shell command as a chip that never wraps inside, with a copy button beside it. */
export function CopyCommand(props: { command: string }) {
  const toast = useToast();
  const { copied, copy } = useCopy(() =>
    toast.error({ title: "Couldn't copy. Select the command and copy it yourself." }),
  );
  return (
    <span className="inline-flex items-center gap-0.5 align-middle whitespace-nowrap">
      <code className="rounded-xs bg-secondary px-1 font-mono text-sm text-foreground">
        {props.command}
      </code>
      <IconButton
        icon={copied ? CheckIcon : CopyIcon}
        label={copied ? "Copied" : "Copy command"}
        size="sm"
        type="button"
        onClick={() => copy(props.command)}
      />
    </span>
  );
}
