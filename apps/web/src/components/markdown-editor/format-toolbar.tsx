import { IconButton } from "@/components/ui/icon-button.tsx";
import { formatCommands, type FormatCommand } from "./commands.ts";

/**
 * The formatting buttons, bare icons with each action's name and shortcut as the tooltip.
 * Pressing one keeps focus in the text (the press never takes it), so the selection it acts on
 * is still there and typing carries on.
 */
export function FormatToolbar(props: {
  disabled?: boolean | undefined;
  onRun(command: FormatCommand): void;
}) {
  return (
    <div role="group" aria-label="Formatting" className="flex flex-wrap items-center">
      {formatCommands.map((command) => (
        <IconButton
          key={command.label}
          size="sm"
          icon={command.icon}
          label={command.label}
          {...(command.keys ? { keys: command.keys, resolve: false } : {})}
          disabled={props.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onRun(command)}
        />
      ))}
    </div>
  );
}
