import { z } from "zod";
import { OffshiftRunMark } from "@ace/protocol/offshift";

/** A thread's latest Offshift run as a notice needs it: no criteria, evidence or outcome. */
export const RunSignal = z
  .object({
    /** The run id and version, which name one write of one run. */
    key: z.string().max(200),
    mark: OffshiftRunMark,
    /** The blocker, else the next step, from the run record (not the transcript). */
    detail: z.string().max(300).optional(),
  })
  .strict();
export type RunSignal = z.infer<typeof RunSignal>;
