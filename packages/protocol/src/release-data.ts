import { z } from "zod";

/** One stored format's number: a version marker or a database's schema version. */
const FormatNumber = z.number().int().nonnegative().max(1_000_000);

/**
 * `ace-data.json`, published with every release from ADR 0174 on: the data formats that build
 * reads and writes. `home` is `HOME_FORMAT_VERSION` (ADR 0081), `daemon` the daemon's schema
 * version, `notify` the notification database's format and `spade` Spade's migration count.
 * Fields a later build adds are kept, never dropped.
 */
export const ReleaseData = z.looseObject({
  home: FormatNumber,
  daemon: FormatNumber,
  notify: FormatNumber,
  spade: FormatNumber,
});
export type ReleaseData = z.infer<typeof ReleaseData>;

/**
 * What a data home holds now, as its daemon reads it: the home's format marker and each
 * database's stored schema version. Null where the home has no such file yet (Spade never
 * started, no notification ever stored) or its version can't be read.
 */
export const HomeData = z.looseObject({
  home: FormatNumber.nullable(),
  daemon: FormatNumber.nullable(),
  notify: FormatNumber.nullable(),
  spade: FormatNumber.nullable(),
});
export type HomeData = z.infer<typeof HomeData>;
