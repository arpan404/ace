import {
  spadeQuoteName,
  type SpadeDocCard,
  type SpadeMessageReactions,
  type SpadeQuote,
} from "@ace/ui-core/spade-chat";
import { FileTextIcon, XIcon } from "@ace/icons";
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
import { cn } from "@/lib/cn.ts";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";

/*
 * Replying to a message and long words in a Spade chat (ADR 0212, docs/design/spade.md §3): the
 * quoted line above a bubble, which takes the person to the original; the composer's strip while
 * they reply; and the document card that holds long words, opened to read all of them.
 */

/** What a chat's bubbles reach to reply to a message and to go to one. */
export interface SpadeReplyHandlers {
  /** Start replying to a message: the composer shows its strip. */
  reply(quote: SpadeQuote): void;
  /** Go to a quoted message: scroll to it and light it a moment. */
  show(id: string): void;
  /** The message lit just now, by id. */
  lit: string | undefined;
  /** Whose words a bot's quote names. */
  botName: string;
  /** What each side reacted with, by message id. */
  reactions: ReadonlyMap<string, SpadeMessageReactions>;
  /** React to a message, or take the person's reaction back (undefined); absent offers none. */
  react: ((id: string, emoji: string | undefined) => void) | undefined;
}

export const SpadeReplyContext = createContext<SpadeReplyHandlers | undefined>(undefined);

export const useSpadeReplies = () => useContext(SpadeReplyContext);

/** The attribute a bubble carries so a quote can find it. */
export const messageAttribute = "data-spade-message";

/**
 * The small quoted line above a bubble: who said it and its first line, on a 2px rule, in the
 * quiet ink. Clicking it goes to the original.
 */
export function QuoteLine(props: { quote: SpadeQuote; side: "bot" | "mine" }) {
  const replies = useSpadeReplies();
  const name = spadeQuoteName(props.quote.who, replies?.botName ?? "Spade");
  return (
    <button
      type="button"
      onClick={() => replies?.show(props.quote.id)}
      aria-label={`Replying to ${name}: ${props.quote.text}. Show the message`}
      className={cn(
        "flex max-w-full min-w-0 items-baseline gap-1.5 rounded-xl border-l-[3px] border-chat-mine bg-chat-bubble px-2.5 py-1.5 text-left text-xs leading-4 text-muted-foreground transition-colors duration-(--motion-fast) hover:text-foreground focus-ring",
        props.side === "mine" ? "self-end" : "self-start",
      )}
    >
      <span className="shrink-0 font-medium">{name}</span>
      <span className="min-w-0 truncate">{props.quote.text}</span>
    </button>
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
        className="flex w-full max-w-[min(100%,52ch)] min-w-0 items-start gap-3 rounded-(--chat-bubble-radius) bg-chat-bubble py-3 pr-3 pl-4"
      >
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
): SpadeReplyHandlers | undefined {
  const [lit, setLit] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback(
    (id: string) => {
      const go = (tries: number) => {
        const target = document.querySelector(`[${messageAttribute}="${CSS.escape(id)}"]`);
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
  return useMemo(
    () => ({ reply: onReply ?? (() => {}), show, lit, botName, reactions, react }),
    [onReply, show, lit, botName, reactions, react],
  );
}
