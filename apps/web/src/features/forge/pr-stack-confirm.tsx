import type { ForgeStackExpected, ForgeStackMovedLayer, ForgeStackOperation } from "@ace/protocol";
import type { StackPublishUpdate } from "@ace/forge/stack-publish";
import { Button } from "@/components/ui/button.tsx";

export type StackConfirmation = {
  action: ForgeStackOperation["action"];
  method: "merge" | "squash" | "rebase";
  expected: ForgeStackExpected;
  numbers: number[];
};

const numbered = (numbers: readonly number[]) => numbers.map((number) => `#${number}`).join(", ");

/** The explicit review of a stack write: affected layers, method and old → new revisions. */
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
  return (
    <div
      role="group"
      aria-label="Confirm stack action"
      className="space-y-2 rounded-md border border-border p-3 text-ui"
    >
      {confirmation.action === "push" ? (
        <>
          <p>Push to origin together, leased to the reviewed revisions:</p>
          <ul aria-label="Layers to publish" className="font-mono text-sm">
            {props.publishing.map((update) => (
              <li key={update.number}>
                #{update.number} {update.branch} {update.lease.slice(0, 7)} →{" "}
                {update.target.slice(0, 7)}
              </li>
            ))}
          </ul>
        </>
      ) : confirmation.action === "sync" ? (
        <>
          <p>
            Fetch GitHub's newer commits, replay them onto these local layers and restack the layers
            above. Nothing is pushed until you publish, which then leases each layer to the head
            GitHub reports now:
          </p>
          <ul aria-label="Layers to bring in" className="font-mono text-sm">
            {props.moved.map((layer) => (
              <li key={layer.number}>
                #{layer.number} {layer.branch} {layer.reviewed.slice(0, 7)}..
                {layer.current.slice(0, 7)}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>
          {confirmation.action === "merge"
            ? `Merge ${numbered(confirmation.numbers)} into ${confirmation.expected.trunk} using ${confirmation.method}. A merge queue chooses its own method.`
            : `${confirmation.action === "abort" ? "Restore" : "Rebase"} local branches for ${numbered(confirmation.numbers)}. Nothing is pushed until you publish.`}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={
            props.disabled ||
            (confirmation.action === "push" && !props.publishing.length) ||
            (confirmation.action === "sync" && !props.moved.length)
          }
          onClick={props.onConfirm}
        >
          Confirm{" "}
          {confirmation.action === "merge"
            ? "stack merge"
            : confirmation.action === "push"
              ? "push"
              : "stack action"}
        </Button>
        <Button size="sm" disabled={props.pending} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
