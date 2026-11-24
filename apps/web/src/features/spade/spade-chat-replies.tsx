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
import type { QuoteAccentVariables } from "./spade-accent.ts";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";

/*
 * Replying to a message and long words in a Spade chat (ADR 0212, docs/design/spade.md §3): the
 * compact quote inset inside the top of a bubble (jumping to the original on click), the
 * composer's strip while replying, and the document card for long words.
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
  /** Accent colour variables for the quoted sender's 2px bar, if that sender has a colour. */
  accentOf?: ((who: SpadeQuote["who"]) => QuoteAccentVariables | undefined) | undefined;
}

export const SpadeReplyContext = createContext<SpadeReplyHandlers | undefined>(undefined);

export const useSpadeReplies = () => useContext(SpadeReplyContext);

/** The primary attribute a bubble carries so a quote can find it. */
export const messageAttribute = "data-spade-message";

/** Space-separated list of all merged message ids inside a single coalesced bubble. */
export const messageIdsAttribute = "data-spade-message-ids";

/**
 * Compact quote inset inside the top of a bubble: a 2px rounded accent bar in the quoted sender's
 * colour, their name in 12px semibold, and one truncated line of the quoted text in 12px muted.
 * Clicking anywhere on the inset scrolls to and highlights the original message.
 */
export function QuoteInset(props: { quote: SpadeQuote; side: "bot" | "mine" }) {
  const replies = useSpadeReplies();
  const name = spadeQuoteName(props.quote.who, replies?.botName ?? "Spade");
  const accent = replies?.accentOf?.(props.quote.who);
  const mine = props.side === "mine";
  return (
    <button
      type="button"
      onClick={() => replies?.show(props.quote.id)}
      aria-label={`Replying to ${name}: ${props.quote.text}. Show the message`}
      style={accent}
      className={cn(
        "mb-2 flex w-full min-w-0 cursor-pointer items-stretch gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left transition-colors duration-(--motion-fast) focus-ring",
        mine
          ? "bg-chat-mine-foreground/[0.12] hover:bg-chat-mine-foreground/[0.18]"
          : "bg-foreground/[0.05] hover:bg-foreground/[0.08]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "w-[2px] shrink-0 self-stretch rounded-full",
          mine
            ? accent
              ? "bg-[oklch(from_var(--quote-accent-light)_0.86_c_h)] dark:bg-[oklch(from_var(--quote-accent-dark)_0.88_c_h)]"
              : "bg-chat-mine-foreground/75"
            : accent
              ? "bg-(--quote-accent-light) dark:bg-(--quote-accent-dark)"
              : "bg-chat-mine",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-[12px] leading-4 font-semibold",
            mine ? "text-chat-mine-foreground" : "text-foreground",
          )}
        >
          {name}
        </span>
        <span
          className={cn(
            "truncate text-[12px] leading-4",
            mine ? "text-chat-mine-meta" : "text-muted-foreground",
          )}
        >
          {props.quote.text}
        </span>
      </span>
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
export function DocumentCard(props: { doc: SpadeDocCard; quote?: SpadeQuote | undefined }) {
  const [open, setOpen] = useState(false);
  const { doc } = props;
  return (
    <>
      <div
        role="group"
        aria-label={doc.title}
        className="flex w-full max-w-[min(100%,52ch)] min-w-0 flex-col rounded-(--chat-bubble-radius) bg-chat-bubble px-4 py-3.5"
      >
        {props.quote && <QuoteInset quote={props.quote} side="bot" />}
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
  accentOf?: ((who: SpadeQuote["who"]) => QuoteAccentVariables | undefined) | undefined,
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
  return useMemo(
    () => ({ reply: onReply ?? (() => {}), show, lit, botName, reactions, react, accentOf }),
    [onReply, show, lit, botName, reactions, react, accentOf],
  );
}
