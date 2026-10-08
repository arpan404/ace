import { extensionDisplayName } from "@ace/ui-core";
// oxlint-disable react/no-array-index-key -- ordered content parts have no independent identity.
import type { ContentPart } from "@ace/protocol";
import { Fragment } from "react";
import { MentionChip } from "@/components/mention-chip.tsx";
export function MessageReferences(props: { parts: readonly ContentPart[] }) {
  return props.parts.map((part, index) => (
    <Fragment key={index}>
      {part.type === "text" ? (
        part.text
      ) : part.type === "mention" ? (
        <MentionChip
          name={
            part.title ??
            extensionDisplayName(
              part.name,
              undefined,
              part.kind === "agent" && part.name.includes(":")
                ? part.name.split(":")[0]
                : undefined,
            )
          }
          kind={part.kind}
        />
      ) : null}
    </Fragment>
  ));
}
