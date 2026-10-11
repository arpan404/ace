import { extensionDisplayName, sanitizeUserText } from "@ace/ui-core";
// oxlint-disable react/no-array-index-key -- ordered content parts have no independent identity.
import type { ContentPart } from "@ace/protocol";
import { Fragment } from "react";
import { MentionChip } from "@/components/mention-chip.tsx";
export function MessageReferences(props: { parts: readonly ContentPart[] }) {
  // Keep references as opaque markers while the shared sanitizer reads the whole message.
  // A delimiter absent from the text cannot collide with words the person wrote.
  const text = props.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  let marker = "ace-reference";
  let delimiter = `\uE000${marker}\uE001`;
  while (text.includes(delimiter)) {
    marker += marker;
    delimiter = `\uE000${marker}\uE001`;
  }
  const source = props.parts
    .map((part, index) =>
      part.type === "text"
        ? part.text
        : part.type === "mention"
          ? `${delimiter}${index}${delimiter}`
          : "",
    )
    .join("");
  const cleaned = source.replace(source.trim(), () => sanitizeUserText(source));
  return cleaned.split(delimiter).map((value, index) => {
    const part = index % 2 ? props.parts[Number(value)] : undefined;
    return (
      <Fragment key={index}>
        {!part ? (
          value
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
    );
  });
}
