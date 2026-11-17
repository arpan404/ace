import { z } from "zod";

/** One stored format's number: a version marker or a database's schema version. */
const FormatNumber = z.number().int().nonnegative().max(1_000_000);

/**
 * `ace-data.json`, published with every release from ADR 0177 on: the data formats that build
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
 * database's stored schema version. Null where the home has no such file (Spade never started,
 * no notification ever stored). A file that is there but couldn't be read (locked, damaged, a
 * timeout) is null too and named in `unreadable`, which blocks any switch to an older release:
 * its version is unknown, not absent. Daemons from before `unreadable` never send it.
 */
export const HomeData = z.looseObject({
  home: FormatNumber.nullable(),
  daemon: FormatNumber.nullable(),
  notify: FormatNumber.nullable(),
  spade: FormatNumber.nullable(),
  unreadable: z.array(z.string().min(1).max(64)).max(32).optional(),
});
export type HomeData = z.infer<typeof HomeData>;
