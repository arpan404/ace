import { referenceSegments } from "@ace/ui-core";
// oxlint-disable react/no-array-index-key -- ordered content parts have no independent identity.
import type { ContentPart } from "@ace/protocol";
import { Fragment } from "react";
import { MentionChip } from "@/components/mention-chip.tsx";

/** The person's words with each mention as a chip where it was written. */
export function MessageReferences(props: { parts: readonly ContentPart[] }) {
  return referenceSegments(props.parts).map((segment, index) => (
    <Fragment key={index}>
      {segment.kind === "text" ? (
        segment.text
      ) : (
        <MentionChip name={segment.name} kind={segment.mention} />
      )}
    </Fragment>
  ));
}
