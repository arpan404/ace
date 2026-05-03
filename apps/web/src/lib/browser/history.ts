import * as Schema from "effect/Schema";
import {
  BROWSER_HISTORY_STORAGE_KEY,
  buildBrowserSuggestions,
  MAX_BROWSER_HISTORY_ENTRIES,
  MAX_BROWSER_SUGGESTIONS,
  recordBrowserHistory,
  type BrowserHistory,
  type BrowserHistoryEntry,
  type BrowserSuggestion,
} from "@ace/shared/browserHistory";

export {
  BROWSER_HISTORY_STORAGE_KEY,
  buildBrowserSuggestions,
  MAX_BROWSER_HISTORY_ENTRIES,
  MAX_BROWSER_SUGGESTIONS,
  recordBrowserHistory,
  type BrowserHistory,
  type BrowserHistoryEntry,
  type BrowserSuggestion,
};

export const BrowserHistoryEntrySchema = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  visitedAt: Schema.Number,
  visitCount: Schema.Number.pipe(Schema.withDecodingDefault(() => 1)),
});

export const BrowserHistorySchema = Schema.Array(BrowserHistoryEntrySchema);
