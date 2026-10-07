import {
  CheckCircleIcon,
  MinusCircleIcon,
  QuestionIcon,
  WarningCircleIcon,
  WarningIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { InteractionMeasurement } from "@ace/protocol";
import {
  confidenceText,
  measuredText,
  measurementMetrics,
  measurementRuns,
  outcomeText,
  readMeasurement,
  verdictText,
  type MeasurementResult,
} from "@ace/ui-core/interaction-measurement";
import { useId, useMemo, useState, type ReactNode } from "react";
import { ImageTile } from "@/components/attachment-tiles.tsx";
import { useLightbox } from "@/components/attachment-open.tsx";
import type { ShownImage } from "@/components/attachment-format.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { cn } from "@/lib/cn.ts";
import { MeasurementTimeline } from "./measurement-timeline.tsx";
import type { useStepDisplay } from "./use-step-display.ts";

/*
 * A smoothness measurement in the work log (`screen_measure_interaction`,
 * `ace_browser_measure_interaction`): one quiet row with the verdict and its key number, which
 * opens to the card. Loaded only when a log holding one opens; until then, and for a run still
 * going or a result the payloads no longer hold, the step reads as an ordinary row (`plain`).
 */

const icons: Record<InteractionMeasurement["verdict"], PhosphorIcon> = {
  smooth: CheckCircleIcon,
  minor_hitches: WarningCircleIcon,
  janky: WarningIcon,
  no_change: MinusCircleIcon,
  inconclusive: QuestionIcon,
};

type StepDisplay = NonNullable<ReturnType<typeof useStepDisplay>>;

export function MeasurementStep(props: { data: StepDisplay; plain: ReactNode }) {
  const { item, step } = props.data;
  const result = useMemo(
    () => (item.type === "tool_call" ? readMeasurement(item.call) : undefined),
    [item],
  );
  const [open, setOpen] = useState(false);
  const panel = useId();
  if (!result) return props.plain;
  const { measurement } = result;
  const verdict = verdictText(measurement.verdict);
  const Glyph = icons[measurement.verdict];
  const measured = measuredText(measurement);
  const outcome = outcomeText(measurement);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        aria-label={["Measured smoothness:", measured, outcome, step.note]
          .filter(Boolean)
          .join(" ")}
        onClick={() => setOpen(!open)}
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent"
      >
        <Glyph aria-hidden size={14} data-tone={verdict.tone} className="shrink-0 text-(--tone)" />
        <span className="shrink-0">Measured smoothness</span>
        <span className="min-w-0 truncate text-foreground">{measured}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-xs text-subtle-foreground">
          <span>{outcome}</span>
          {step.note && (
            <span className={cn(step.failed && "text-status-failed")}>{step.note}</span>
          )}
        </span>
      </button>
      {open && (
        <div id={panel} className="mt-1 mb-2 pl-6">
          <MeasurementCard result={result} />
        </div>
      )}
    </li>
  );
}

/**
 * The verdict, what was done where, the headline numbers (median · worst over repeats) with
 * each run's verdict, the timeline, how sure the tool is, and the filmstrip.
 */
function MeasurementCard(props: { result: MeasurementResult }) {
  const { measurement, filmstrip } = props.result;
  const verdict = verdictText(measurement.verdict);
  const Glyph = icons[measurement.verdict];
  const metrics = measurementMetrics(measurement);
  const runs = measurementRuns(measurement);
  const measured = measuredText(measurement);
  return (
    <section
      aria-label={`Smoothness: ${measured}`}
      className="flex flex-col gap-2.5 text-ui text-muted-foreground"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="outline" data-tone={verdict.tone}>
          <Glyph aria-hidden className="text-(--tone)" />
          {verdict.label}
        </Badge>
        <span>{measured}</span>
      </p>
      {metrics.length > 0 && (
        <dl className="flex flex-wrap gap-x-4 gap-y-1">
          {metrics.map((metric) => (
            <div key={metric.label} className="flex flex-col">
              <dt className="text-xs text-subtle-foreground">{metric.label}</dt>
              <dd className="font-mono text-foreground tabular-nums">{metric.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {runs.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle-foreground">
          <span>{runs.length} runs, median · worst</span>
          <ul aria-label="Runs" className="flex items-center gap-1">
            {runs.map((run) => (
              <li key={run.label} className="flex">
                <span
                  role="img"
                  aria-label={run.label}
                  data-tone={run.tone}
                  className="inline-block size-1.5 shrink-0 rounded-full bg-(--tone)"
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      <MeasurementTimeline measurement={measurement} />
      <Confidence measurement={measurement} />
      {filmstrip && <Filmstrip url={filmstrip} />}
    </section>
  );
}

/** "Low confidence: host was busy", quietly, and the tool's notes behind a toggle. */
function Confidence(props: { measurement: InteractionMeasurement }) {
  const { notes } = props.measurement;
  const confidence = confidenceText(props.measurement);
  const [open, setOpen] = useState(false);
  const list = useId();
  if (!confidence && !notes.length) return null;
  return (
    <div className="flex flex-col gap-1 text-xs text-subtle-foreground">
      <p className="flex flex-wrap items-center gap-x-2">
        {confidence && <span>{confidence}</span>}
        {notes.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={list}
            onClick={() => setOpen(!open)}
            className="underline-offset-2 hover:text-foreground hover:underline"
          >
            {notes.length === 1 ? "1 note" : `${notes.length} notes`}
          </button>
        )}
      </p>
      {open && (
        <ul id={list} aria-label="Notes" className="list-disc pl-4">
          {notes.map((note, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- notes can repeat; position is identity.
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The timestamped filmstrip; it opens full size in the image lightbox. */
function Filmstrip(props: { url: string }) {
  const images = useMemo<ShownImage[]>(
    () => [{ key: "filmstrip", name: "Filmstrip", source: { kind: "url", url: props.url } }],
    [props.url],
  );
  const { show, lightbox } = useLightbox(images);
  const [image] = images;
  if (!image) return null;
  return (
    <div className="self-start">
      <ImageTile
        image={image}
        size={{ width: 240, height: 120 }}
        fit="contain"
        onOpen={(element) => show(0, element)}
      />
      {lightbox}
    </div>
  );
}
