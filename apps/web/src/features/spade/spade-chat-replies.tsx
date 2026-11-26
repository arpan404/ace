import {
  type SpadeAvatar,
  type SpadeDocCard,
  type SpadeDocumentRef,
  type SpadeImageRef,
  type SpadeMessageReactions,
  type SpadeQuote,
  spadeQuoteName,
} from "@ace/ui-core/spade-chat";
import { FileTextIcon, PaperclipIcon, XIcon } from "@ace/icons";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { part } from "@/lib/suit-part.ts";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import { PictureThumb } from "./spade-attachment-image.tsx";

/*
 * Replying to a message and long words in a Spade chat (ADR 0212, docs/design/spade.md §3): the
 * messenger-style muted label + faded ghost bubble above a reply (jumping to the original on
 * click), the composer's strip while replying, and the document card for long words.
 */

/** A reactor's display identity for reaction hover/long-press popovers. */
export interface SpadeReactor {
  name: string;
  avatar?: SpadeAvatar | undefined;
}

/** What a chat's bubbles reach to reply to a message, react to one, and jump to a quoted one. */
export interface SpadeReplyHandlers {
  /** Start replying to a message: the composer shows its strip. */
  reply(quote: SpadeQuote): void;
  /** Go to a quoted message: scroll to it and light it a moment. */
  show(id: string): void;
  /** The message lit just now, by id. */
  lit: string | undefined;
  /** Whose words a bot's quote names. */
  botName: string;
  /** What each reactor put on a message, by message id. */
  reactions: ReadonlyMap<string, SpadeMessageReactions>;
  /** React to a message, or take the person's reaction back (undefined); absent offers none. */
  react: ((id: string, emoji: string | undefined) => void) | undefined;
  /** True in clubs: the person can react to any message, including their own. */
  canReactOwn?: boolean | undefined;
  /** Resolve a reactor id (`"person"`, `"bot"`, or club member agent id) to face and name. */
  reactorOf?: ((id: string) => SpadeReactor | undefined) | undefined;
  /** The pictures and files of a message in this chat, by id; none for one in another chat. */
  attachmentsOf?: ((id: string) => QuotedAttachments | undefined) | undefined;
}

/** What a quoted message carried besides words, when it is in this chat. */
export interface QuotedAttachments {
  images: readonly SpadeImageRef[];
  documents: readonly SpadeDocumentRef[];
}

export const SpadeReplyContext = createContext<SpadeReplyHandlers | undefined>(undefined);

export const useSpadeReplies = () => useContext(SpadeReplyContext);

/** The primary attribute a bubble carries so a quote can find it. */
export const messageAttribute = "data-spade-message";

/** Space-separated list of all merged message ids inside a single coalesced bubble. */
export const messageIdsAttribute = "data-spade-message-ids";

/** Quiet label above a reply's ghost bubble ("Replied to you", "You replied to Flights", etc.). */
export function replyLabel(
  quote: SpadeQuote,
  side: "bot" | "mine",
  botName: string,
  replier?: string,
): string {
  if (side === "mine") {
    if (quote.who.kind === "person") return "You replied to yourself";
    return `You replied to ${spadeQuoteName(quote.who, botName)}`;
  }
  if (quote.who.kind === "person") return "Replied to you";
  const target = spadeQuoteName(quote.who, botName);
  if (replier && replier === target) return `${replier} replied to itself`;
  return replier ? `${replier} replied to ${target}` : `Replied to ${target}`;
}

/** What the ghost says in words: the quoted words, else its file names, else "Attachment". */
function quoteWords(quote: SpadeQuote, attachments: QuotedAttachments | undefined): string {
  if (quote.text) return quote.text;
  const names = attachments?.documents.map((doc) => doc.name) ?? [];
  if (names.length > 0) return names.join(", ");
  if (attachments && attachments.images.length > 0) return "Photo";
  return "Attachment";
}

/**
 * The ghost's content: the quoted words; a mini thumbnail for a picture and the name of a file
 * when the message carried them (or when it carried only them); a paperclip and "Attachment"
 * for a message with no words that isn't in this chat (another conversation or club).
 */
function GhostBody(props: { quote: SpadeQuote; attachments: QuotedAttachments | undefined }) {
  const { quote, attachments } = props;
  const [image] = attachments?.images ?? [];
  const [doc] = attachments?.documents ?? [];
  const media = image ? (
    <PictureThumb image={image} className="size-9 shrink-0 rounded-md" />
  ) : doc ? (
    <Icon icon={FileTextIcon} size={16} className="shrink-0" />
  ) : !quote.text ? (
    <Icon icon={PaperclipIcon} size={14} className="shrink-0" />
  ) : null;
  const words = quote.text || (doc ? doc.name : image ? "Photo" : "Attachment");
  return (
    <span className="flex min-w-0 items-center gap-2">
      {media}
      <span className="line-clamp-2 min-w-0 break-words">{words}</span>
    </span>
  );
}

/**
 * Messenger-style reply context sitting directly above a reply bubble: a muted 12px label
 * ("Replied to you" / "You replied to Flights" / "Flights replied to Inbox") and a compact faded
 * ghost bubble in the original sender's shape and colour. Clicking jumps to and highlights the
 * original message.
 */
export function ReplyGhost(props: {
  quote: SpadeQuote;
  side: "bot" | "mine";
  /** Club member name when a club member is replying (e.g. "Flights"). */
  replier?: string | undefined;
}) {
  const replies = useSpadeReplies();
  const label = replyLabel(props.quote, props.side, replies?.botName ?? "Spade", props.replier);
  const mine = props.side === "mine";
  const quotedPerson = props.quote.who.kind === "person";
  const attachments = replies?.attachmentsOf?.(props.quote.id);
  return (
    <div
      {...part("spade-reply-ghost", undefined, mine ? "mine" : "bot")}
      className={cn("flex max-w-full min-w-0 flex-col", mine ? "items-end" : "items-start")}
    >
      <span
        className={cn(
          "mb-1 max-w-full truncate text-[12px] leading-4 text-muted-foreground",
          mine ? "pr-1.5 text-right" : "pl-1.5 text-left",
        )}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={() => replies?.show(props.quote.id)}
        aria-label={`${label}: ${quoteWords(props.quote, attachments)}. Show the message`}
        className={cn(
          // Extra bottom padding leaves room for the reply bubble overlapping by 6px.
          "max-w-[min(100%,42ch)] min-w-0 cursor-pointer rounded-[16px] px-3 pt-1.5 pb-2.5 text-left text-[13px] leading-[1.38] transition-[background-color,opacity,color] duration-(--motion-fast) focus-ring",
          mine ? "mr-1.5" : "ml-1.5",
          // Faded by its colours, not by opacity (which fades the words toward the page):
          // quiet text on the chat's well, readable in every theme and scheme.
          "bg-chat-well text-muted-foreground hover:text-foreground",
          quotedPerson
            ? "shadow-[inset_0_0_0_1px_var(--border)]"
            : "shadow-[inset_0_0_0_1px_var(--border-soft)]",
        )}
      >
        <GhostBody quote={props.quote} attachments={attachments} />
      </button>
    </div>
  );
}

/**
 * Inside the composer, above the words, while the person replies: who they answer and one line
 * of it on the quote's 2px rule, with × to stop replying. One sentence-like line, no tint
 * (design-language §2.3). It is the composer's own top line (its `heading`), so it never floats
 * over the transcript, and the transcript's room under the composer grows with it.
 */
export function ReplyStrip(props: { quote: SpadeQuote; botName: string; onClear(): void }) {
  const name = spadeQuoteName(props.quote.who, props.botName);
  return (
    <div
      role="status"
      aria-label={`Replying to ${name}`}
      className="flex min-w-0 items-center gap-2 pt-3 pr-2 pl-4"
    >
      <p className="min-w-0 flex-1 truncate border-l-2 border-border-strong pl-2.5 text-ui text-muted-foreground">
        <span className="font-medium text-foreground">Replying to {name}</span>
        {" · "}
        {props.quote.text}
      </p>
      <IconButton
        icon={XIcon}
        label="Stop replying"
        size="sm"
        className="rounded-full"
        onClick={props.onClear}
      />
    </div>
  );
}

/**
 * Long words as a card on the bot's side (ADR 0212 §5): the document mark, the title, two lines
 * of preview and Open, which shows every word in a sheet over the chat.
 */
export function DocumentCard(props: { doc: SpadeDocCard }) {
  const [open, setOpen] = useState(false);
  const { doc } = props;
  return (
    <>
      <div
        role="group"
        aria-label={doc.title}
        className="flex w-full max-w-[min(100%,52ch)] min-w-0 flex-col rounded-(--chat-bubble-radius) bg-chat-bubble px-4 py-3.5"
      >
        <div className="flex min-w-0 items-start gap-3">
          <FileTextIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-ui font-medium text-foreground">{doc.title}</p>
            {doc.preview && (
              <p className="mt-0.5 line-clamp-2 text-ui text-muted-foreground">{doc.preview}</p>
            )}
          </div>
          <Button size="xs" variant="ghost" className="shrink-0" onClick={() => setOpen(true)}>
            Open
          </Button>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg" className="max-h-[min(85vh,900px)]">
          <DialogHeader>
            <DialogTitle>{doc.title}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <SpadeBubbleText text={doc.text} />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** How long a message gone to from its quote stays lit. */
const litFor = 1600;

export interface UseRepliesOptions {
  canReactOwn?: boolean | undefined;
  reactorOf?: ((id: string) => SpadeReactor | undefined) | undefined;
  attachmentsOf?: ((id: string) => QuotedAttachments | undefined) | undefined;
}

/**
 * Replying in a chat: Reply hands the message to the composer, and a quote goes to its original,
 * drawing every row first when the original is older than the rows drawn yet.
 */
export function useReplies(
  botName: string,
  onReply: ((quote: SpadeQuote) => void) | undefined,
  drawAll: () => void,
  reactions: ReadonlyMap<string, SpadeMessageReactions>,
  onReact: ((id: string, emoji: string | undefined) => Promise<boolean>) | undefined,
  options?: UseRepliesOptions,
): SpadeReplyHandlers | undefined {
  const [lit, setLit] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback(
    (id: string) => {
      const go = (tries: number) => {
        const escaped = CSS.escape(id);
        const target =
          document.querySelector(`[${messageAttribute}="${escaped}"]`) ??
          document.querySelector(`[${messageIdsAttribute}~="${escaped}"]`);
        if (!target) {
          if (tries > 0) {
            drawAll();
            requestAnimationFrame(() => go(tries - 1));
          }
          return;
        }
        const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
        setLit(id);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setLit(undefined), litFor);
      };
      go(3);
    },
    [drawAll],
  );
  const react = useMemo(
    () =>
      onReact ? (id: string, emoji: string | undefined) => void onReact(id, emoji) : undefined,
    [onReact],
  );
  const canReactOwn = options?.canReactOwn;
  const reactorOf = options?.reactorOf;
  const attachmentsOf = options?.attachmentsOf;
  return useMemo(
    () => ({
      reply: onReply ?? (() => {}),
      show,
      lit,
      botName,
      reactions,
      react,
      canReactOwn,
      reactorOf,
      attachmentsOf,
    }),
    [onReply, show, lit, botName, reactions, react, canReactOwn, reactorOf, attachmentsOf],
  );
}
