import { ProviderKind } from "@ace/protocol";
import { dayRange, previousSpan, providerNames, usageCoverage, usageReport } from "@ace/ui-core";
import { z } from "zod";
import { UsagePart } from "./usage-part.ts";
import { usageMetricView, type UsageMetricView } from "./usage-report-view.ts";

/*
 * The Usage screen's Cost and Tokens views across the machines in scope: each machine's part
 * (`usage-part.ts`) summed by the web Usage page's `usageReport`, with growth against the
 * period before and a line naming any machine that isn't counted. Pure: no I/O.
 */

export const UsageMachineReach = z.enum(["counted", "loading", "offline", "failed"]);
const Machine = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  reach: UsageMachineReach,
});

export const UsageCombineRequest = z.object({
  type: z.literal("usage.combine"),
  days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]),
  /** Every machine in scope; a counted one carries its part. */
  machines: z
    .array(Machine.extend({ part: UsagePart.optional() }))
    .min(1)
    .max(32),
});
export type UsageCombineRequest = z.infer<typeof UsageCombineRequest>;

export interface UsageCoverageView {
  /** "2 of 3 machines · Studio is offline"; null for a single counted machine. */
  line: string | null;
  complete: boolean;
}

export interface UsageReportReply {
  type: "usage.report";
  from: string;
  to: string;
  /** The providers that have usage on any counted machine, for the provider filter. */
  providers: { id: string; name: string }[];
  coverage: UsageCoverageView;
  tokens: UsageMetricView;
  cost: UsageMetricView;
}

const providerName = (id: string) => {
  const kind = ProviderKind.safeParse(id);
  return kind.success ? providerNames[kind.data] : id;
};

export function combineUsage(request: UsageCombineRequest): UsageReportReply {
  // Every part counts the days the first counted machine chose; a part kept from other days
  // (an older visit) is still being read again, so it waits instead of skewing the sums.
  const lead = request.machines.find(
    (machine) => machine.reach === "counted" && machine.part,
  )?.part;
  const span = lead ?? { from: "", to: "" };
  const reaches = request.machines.map((machine) => {
    const part = machine.part;
    if (machine.reach !== "counted") return { machine, reach: machine.reach, part: undefined };
    if (!part) return { machine, reach: "failed" as const, part: undefined };
    if (part.from !== span.from || part.to !== span.to)
      return { machine, reach: "loading" as const, part: undefined };
    return { machine, reach: "counted" as const, part };
  });
  const parts = reaches.flatMap((entry) => (entry.part ? [entry.part] : []));
  const coverage = usageCoverage(
    reaches.map(({ machine, reach }) => ({ id: machine.id, name: machine.name, reach })),
  );
  const days = span.from ? dayRange(span.from, span.to) : [];
  const before = span.from ? previousSpan(span.from, span.to) : { from: "", to: "" };
  const modelName = new Map(
    parts.flatMap((part) =>
      part.modelNames.map((entry) => [`${entry.provider}\0${entry.model}`, entry.name]),
    ),
  );
  const names = {
    provider: providerName,
    model: (provider: string, model: string) => modelName.get(`${provider}\0${model}`) ?? model,
  };
  const report = usageReport(parts, days);
  const previous = usageReport(
    parts.map((part) => ({
      daily: part.previous,
      models: [],
      threads: [],
      threadsTruncated: false,
    })),
    before.from ? dayRange(before.from, before.to) : [],
  );
  const listed = [...new Set(parts.flatMap((part) => part.providers))];
  return {
    type: "usage.report",
    from: span.from,
    to: span.to,
    providers: listed.map((id) => ({ id, name: providerName(id) })),
    coverage: { line: coverage.line, complete: coverage.complete },
    tokens: usageMetricView(report, previous, request.days, "tokens", names),
    cost: usageMetricView(report, previous, request.days, "cost", names),
  };
}
