import type { SpadeInvoked } from "@ace/ui-core/spade-chat";

/** The skill or command a message started, as a chip before its words: `/renderer-perf-pass`. */
export function InvokedChip(props: { invoked: SpadeInvoked }) {
  return (
    <span
      data-invoked={props.invoked.kind}
      className="mr-1.5 inline-flex max-w-full items-center rounded-full bg-chat-mine-code px-2 py-0.5 align-baseline text-ui font-medium"
    >
      <span className="truncate">{`/${props.invoked.name}`}</span>
    </span>
  );
}
