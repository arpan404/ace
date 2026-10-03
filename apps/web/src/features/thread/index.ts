/** One thread: transcript, composer, header actions and interactions. */
export { Composer, type Draft } from "./composer/composer.tsx";
export { useDraftScope } from "./composer/draft-scope.ts";
export { ThreadView } from "./thread-view.tsx";
/** Where the reader left a thread; the fake boot seeds it so "New activity" has a place. */
export { markSeen } from "./transcript/seen.ts";
