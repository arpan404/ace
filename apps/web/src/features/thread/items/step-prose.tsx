import { useItem } from "@ace/client-react";
import { use } from "react";
import { Prose } from "@/components/markdown/prose.tsx";
import { AssistantMessage } from "./messages.tsx";
import { StepItems } from "./step-items.ts";

/**
 * What the agent said between two steps: the live message when the thread holds it, else the
 * preview a finished turn's log read with its steps.
 */
export function StepProse(props: { threadId: string; itemId: string }) {
  const live = useItem(props.threadId, props.itemId);
  const fetched = use(StepItems)?.get(props.itemId);
  if (live || fetched?.type !== "message") return <AssistantMessage {...props} between />;
  const text = fetched.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");
  return (
    <div className="font-prose text-prose leading-[1.6] tracking-[-0.005em]">
      <Prose text={text} thread={{ threadId: props.threadId, itemId: props.itemId }} />
    </div>
  );
}
