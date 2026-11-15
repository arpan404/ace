import { themes } from "@ace/themes";
import { Button } from "@/components/ui/button.tsx";
import { part } from "@/lib/suit-part.ts";
import { useSuitLibrary } from "@/theme/suits/suit-library.tsx";
import { useTheme } from "@/theme/theme-provider.tsx";

/**
 * The one strip at the top of Appearance while an agent previews a look on this device: what it
 * previews, then Revert and Keep, which do here what the agent's revert and keep would.
 */
export function PreviewStrip() {
  const { summaries, preview, keepPreview, revertPreview } = useSuitLibrary();
  const { appearance, suitsOff } = useTheme();
  if (preview === undefined || suitsOff) return null;
  const name =
    preview === null
      ? themes[appearance.theme].name
      : (summaries?.find((summary) => summary.id === preview)?.name ?? preview);
  return (
    <div
      role="status"
      {...part("card", "active", "look-preview")}
      className="mb-6 flex items-center justify-between gap-3 rounded-lg bg-surface-1 py-2 pr-2 pl-4 text-ui"
    >
      <span className="min-w-0">
        An agent is previewing <span className="font-medium">{name}</span>.
      </span>
      <span className="flex shrink-0 gap-1.5">
        <Button size="sm" onClick={revertPreview}>
          Revert
        </Button>
        <Button size="sm" variant="primary" onClick={keepPreview}>
          Keep
        </Button>
      </span>
    </div>
  );
}
