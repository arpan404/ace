/*
 * `@ace/ui-core/market`: the marketplace's words and choices, pure, shared by the web's
 * marketplace and the phone's bridge (ADR 0168 §12) so neither copies the other's rules.
 */
export { entryAction, installBlock, typeWord } from "./entry.ts";
export {
  failureSentence,
  findingRows,
  findingSentences,
  MarketFailure,
  type FindingRow,
  type MarketStep,
} from "./failure.ts";
export {
  codeKey,
  decidedEachTime,
  effectDefaults,
  effectWords,
  limitSentences,
  triggerWhen,
} from "./package-words.ts";
export {
  canDoSentences,
  missingNeedsSentence,
  needCatalogue,
  needDefaults,
  replacesLine,
  reviewAction,
  reviewFromLine,
  reviewHeading,
} from "./review.ts";
export { andList, count, dateText, flaggedWord, readAtText, sentence, sizeText } from "./words.ts";
