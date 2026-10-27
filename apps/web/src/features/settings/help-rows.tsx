import { windowsHelpActions } from "@/boot/help-actions.ts";

/**
 * Windows: Help, Report an issue and Show logs, which macOS and Linux keep in the app menu. Plain
 * words under a hairline, after the update row; nothing on other platforms.
 */
export function HelpRows(props: { scope?: object }) {
  const actions = windowsHelpActions(props.scope);
  if (!actions) return null;
  return (
    <nav aria-label="Help" className="flex flex-col items-start border-t border-border py-2">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="h-8 rounded-sm text-md text-foreground hover:underline focus-ring"
          onClick={() => void action.run().catch(() => {})}
        >
          {action.label}
        </button>
      ))}
    </nav>
  );
}
