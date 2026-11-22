import {
  spadeTogetherLine,
  spadeTogetherState,
  spadeTogetherTranscript,
  type SpadeAvatar,
  type SpadeTogetherRow,
  type SpadeTranscriptLine,
} from "@ace/ui-core/spade-chat";
import { cn } from "@/lib/cn.ts";
import { SpadeFace } from "./spade-face.tsx";
import { SpadeSubagentRow } from "./spade-subagent-card.tsx";

/*
 * A row of a turn's card for a message the bot sent another bot, or a contract it called: the
 * subagent card's row (`SpadeSubagentRow`), the other bot's face and name, and on its second
 * line what came back in plain words, or its live phrase while a reply is owed. It opens in
 * place to the exchange: what this bot sent, then what came back, each under its sender's name.
 * Its time shows only while it is owed; the card's first line holds the rest.
 */

/** What these rows read of the chat: this bot, and the other bots it knows. */
export interface SpadeTalkContext {
  self: { name: string; avatar: SpadeAvatar };
  /** Every bot's name by id. */
  names: ReadonlyMap<string, string>;
  /** A bot's face by id. */
  face(id: string): SpadeAvatar;
  /** What each other working bot says it does now, by id. */
  phrases: ReadonlyMap<string, string> | undefined;
}

/** A bot named by id or by its exact name, as a message to it names it. */
export function spadeTalkPeer(context: SpadeTalkContext, ref: string, id?: string) {
  const known =
    id ?? (context.names.has(ref) ? ref : [...context.names].find(([, name]) => name === ref)?.[0]);
  return {
    id: known,
    name: (known && context.names.get(known)) || ref,
    face: context.face(known || ref),
    phrase: known ? context.phrases?.get(known) : undefined,
  };
}

export function SpadeTalkRow(props: {
  row: Exclude<SpadeTogetherRow, { kind: "worker" }>;
  context: SpadeTalkContext;
  /** How long it has been owed, while it is. */
  elapsed: React.ReactNode;
}) {
  const { row, context } = props;
  const peer =
    row.kind === "message"
      ? spadeTalkPeer(context, row.bot)
      : spadeTalkPeer(context, row.call.bot, row.call.botId);
  const state = spadeTogetherState(row);
  const machine = row.kind === "message" ? row.machine : row.call.machine;
  const transcript = spadeTogetherTranscript(row, {
    self: context.self.name,
    other: peer.name,
    phrase: peer.phrase,
  });
  return (
    <SpadeSubagentRow
      row={{
        id: row.key,
        kind: "bot",
        name: peer.name,
        state,
        line: spadeTogetherLine(row, peer.phrase),
        provider: undefined,
        face: peer.face,
        machine,
        elapsed: state === "working" ? props.elapsed : undefined,
        open: undefined,
        onReview: undefined,
        expand: (
          <ol aria-label={`The exchange with ${peer.name}`} className="flex flex-col gap-2.5">
            {transcript.map((line) => (
              <Said
                key={line.key}
                line={line}
                face={line.from === "self" ? context.self.avatar : peer.face}
              />
            ))}
          </ol>
        ),
      }}
    />
  );
}

/** One line of the exchange: a small name label over its whole text. */
function Said(props: { line: SpadeTranscriptLine; face: SpadeAvatar }) {
  const { line } = props;
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-xs leading-4 text-subtle-foreground">
        <SpadeFace avatar={props.face} size={14} />
        {line.name}
      </span>
      <p
        className={cn(
          "text-ui leading-5 break-words whitespace-pre-wrap",
          line.failed
            ? "text-(--status-failed-text)"
            : line.live
              ? "step-shimmer text-muted-foreground"
              : "text-foreground",
        )}
      >
        {line.text}
      </p>
    </li>
  );
}
