import {
  parseSpadeAvatar,
  spadeContractAskedCard,
  spadeContractCard,
  spadeTalkCard,
  type SpadeAvatar,
  type SpadeChatItem,
} from "@ace/ui-core/spade-chat";
import { SpadeTalkCardView } from "./spade-talk-card.tsx";

/*
 * The chat items that are a bot talking with another bot, drawn as conversation cards: the
 * messages one turn sent (`talk`), a contract call it made (`contract`), and a contract call
 * another bot made to it (an `other` message that carries one).
 */

/** What the cards need of the chat: this bot, and the other bots it knows. */
export interface SpadeTalkContext {
  self: { id: string; name: string; avatar: SpadeAvatar };
  /** Every bot's name by id. */
  names: ReadonlyMap<string, string>;
  /** Faces of bots on this bot's machine, by id. */
  faces: ReadonlyMap<string, SpadeAvatar>;
  /** What each working bot says it does now, by id. */
  phrases: ReadonlyMap<string, string> | undefined;
  /** This bot is at work: a contract call it was given is being answered. */
  busy: boolean;
  onOpenBot: ((id: string) => void) | undefined;
}

/** A bot named by id or by its exact name, as a message to it names it. */
function peer(context: SpadeTalkContext, ref: string, id?: string) {
  const known =
    id ?? (context.names.has(ref) ? ref : [...context.names].find(([, name]) => name === ref)?.[0]);
  const name = (known && context.names.get(known)) || ref;
  const face = (known && context.faces.get(known)) || parseSpadeAvatar(undefined, known || ref);
  const open = context.onOpenBot;
  return {
    name,
    face,
    phrase: known ? context.phrases?.get(known) : undefined,
    open: known && open ? () => open(known) : undefined,
  };
}

export function SpadeTalkItem(props: {
  item: Extract<SpadeChatItem, { kind: "talk" | "contract" | "other" }>;
  context: SpadeTalkContext;
}) {
  const { item, context } = props;
  const self = context.self;
  if (item.kind === "talk") {
    const other = peer(context, item.bot);
    const card = spadeTalkCard(
      { ...item, kind: "talk" },
      { self: self.name, other: other.name, otherPhrase: other.phrase },
    );
    return (
      <SpadeTalkCardView
        card={card}
        faces={{ self: self.avatar, other: other.face }}
        otherName={other.name}
        onOpenOther={other.open}
      />
    );
  }
  if (item.kind === "contract") {
    const other = peer(context, item.call.bot, item.call.botId);
    const card = spadeContractCard(item.call, { otherPhrase: other.phrase });
    return (
      <SpadeTalkCardView
        card={card}
        faces={{ self: self.avatar, other: other.face }}
        otherName={other.name}
        onOpenOther={other.open}
      />
    );
  }
  if (!item.contract) return null;
  const other = peer(context, item.agent.name, item.agent.id);
  const card = spadeContractAskedCard(item.contract, {
    from: item.agent.name || other.name,
    self: self.name,
    working: context.busy,
  });
  return (
    <SpadeTalkCardView
      card={card}
      faces={{ self: self.avatar, other: other.face }}
      otherName={other.name}
      onOpenOther={other.open}
    />
  );
}
