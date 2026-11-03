/*
 * Replying to part of what an agent said: select words in its message, Reply puts them above the
 * composer, and they travel before the person's words as a block the agent reads (ui-core
 * message-quotes).
 */
export { useDraftQuotes, type DraftQuotesState, type QuotesHandOff } from "./draft-quotes.ts";
export { ReplyQuotes } from "./reply-quotes.tsx";
export { QuotesCard } from "./quotes-card.tsx";
export { QuoteLayer } from "./quote-layer.tsx";
