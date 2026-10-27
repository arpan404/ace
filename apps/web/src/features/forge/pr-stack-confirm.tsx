import type { ForgeStackMovedLayer } from "@ace/protocol";
import { stackConfirmationText, type StackConfirmation } from "@ace/ui-core";
import type { StackPublishUpdate } from "@ace/forge/stack-publish";
import { Button } from "@/components/ui/button.tsx";

export type { StackConfirmation } from "@ace/ui-core";

/**
 * The explicit review of a stack write: affected layers, method and old → new revisions. The
 * words are `@ace/ui-core`'s (`stackConfirmationText`), the same the phone shows.
 */
export function StackConfirm(props: {
  confirmation: StackConfirmation;
  publishing: readonly StackPublishUpdate[];
  /** Layers GitHub moved since review; a sync brings their new commits in. */
  moved: readonly ForgeStackMovedLayer[];
  disabled: boolean;
  pending: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const { confirmation } = props;
  const words = stackConfirmationText(confirmation, props.moved);
  const listLabel =
    confirmation.action === "push"
      ? "Layers to publish"
      : confirmation.action === "sync"
        ? "Layers to bring in"
        : undefined;
  return (
    <div
      role="group"
      aria-label="Confirm stack action"
      className="space-y-2 rounded-md border border-border p-3 text-ui"
    >
      <p>{words.text}</p>
      {listLabel && (
        <ul aria-label={listLabel} className="font-mono text-sm">
          {words.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={
            props.disabled ||
            !words.ready ||
            (confirmation.action === "push" && !props.publishing.length)
          }
          onClick={props.onConfirm}
        >
          {words.confirm}
        </Button>
        <Button size="sm" disabled={props.pending} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
