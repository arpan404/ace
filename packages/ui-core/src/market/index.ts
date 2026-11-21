/*
 * `@ace/ui-core/market`: the marketplace's words and choices, pure, shared by the web's
 * marketplace and the phone's bridge (ADR 0168 §12) so neither copies the other's rules.
 */
export { entryAction, installBlock, offeredUpdate, typeWord } from "./entry.ts";
export { failureSentence, findingSentences, MarketFailure, type MarketStep } from "./failure.ts";
export {
  codeKey,
  decidedEachTime,
  effectDefaults,
  effectWords,
  limitSentences,
  triggerWhen,
} from "./package-words.ts";
export { canDoSentences, needCatalogue, needDefaults } from "./review.ts";
export { andList, count, dateText, flaggedWord, readAtText, sentence, sizeText } from "./words.ts";
