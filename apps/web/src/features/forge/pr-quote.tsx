import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { quoted } from "@ace/ui-core";

/** Where quoted text goes: the conversation's comment box, or one review thread's reply. */
export type QuoteTarget = "conversation" | `thread:${string}`;

interface Quote {
  target: QuoteTarget;
  text: string;
  seq: number;
}

const Context = createContext<{
  quote(target: QuoteTarget, body: string): void;
  pending: Quote | undefined;
  take(seq: number): void;
} | null>(null);

/** Appends `addition` to `text`, on a new paragraph when the text already says something. */
export function appendTo(text: string, addition: string): string {
  if (!text.trim()) return addition;
  return `${text.replace(/\s*$/, "")}\n\n${addition}`;
}

/**
 * Quote reply between a comment and the box that answers it. A quote waits here until that box
 * is on screen (the conversation box lives in the Timeline, so quoting from the Summary first
 * opens it with `onConversation`), then the box takes it once.
 */
export function PrQuoteProvider(props: { onConversation(): void; children: ReactNode }) {
  const [pending, setPending] = useState<Quote>();
  // The latest opener, so the context's value changes only with the quote itself.
  const opener = useRef(props.onConversation);
  useLayoutEffect(() => {
    opener.current = props.onConversation;
  });
  const value = useMemo(
    () => ({
      pending,
      quote: (target: QuoteTarget, body: string) => {
        setPending((current) => ({ target, text: quoted(body), seq: (current?.seq ?? 0) + 1 }));
        if (target === "conversation") opener.current();
      },
      take: (seq: number) => setPending((current) => (current?.seq === seq ? undefined : current)),
    }),
    [pending],
  );
  return <Context value={value}>{props.children}</Context>;
}

/** Starts a quote reply; undefined outside a pull request. */
export function useQuote() {
  return useContext(Context)?.quote;
}

/** Hands a box the quote meant for `target` once, while it is mounted and `enabled`. */
export function useQuotedInto(target: QuoteTarget, apply: (text: string) => void, enabled = true) {
  const context = useContext(Context);
  const pending = context?.pending;
  const take = context?.take;
  const applied = useEffectEvent(apply);
  useEffect(() => {
    if (!enabled || !pending || pending.target !== target || !take) return;
    take(pending.seq);
    applied(pending.text);
  }, [enabled, pending, target, take]);
}
