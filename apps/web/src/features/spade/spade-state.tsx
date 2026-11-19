import type { SpadeStateLine } from "@ace/ui-core/spade-chat";
import { Button } from "@/components/ui/button.tsx";
import { useSpadeEnabled } from "./use-spade-enabled.ts";

/** The strip alone in a column, as the screen's whole content: centred, sentence over its button. */
export const centeredStrip = "flex flex-col items-center gap-2 text-center text-ui";

/** Spade's state in one sentence, with Turn on while the setting is off. */
export function SpadeStateStrip(props: { line: SpadeStateLine; className?: string }) {
  const [, setEnabled, saving] = useSpadeEnabled();
  return (
    <div
      role="status"
      className={props.className ?? "flex min-h-7 min-w-0 items-center gap-1.5 px-4 pb-1 text-xs"}
    >
      <span className="min-w-0 flex-1 text-muted-foreground">{props.line.sentence}</span>
      {props.line.canTurnOn && (
        <Button size="xs" variant="ghost" disabled={saving} onClick={() => void setEnabled(true)}>
          {saving ? "Turning on…" : "Turn on"}
        </Button>
      )}
    </div>
  );
}
