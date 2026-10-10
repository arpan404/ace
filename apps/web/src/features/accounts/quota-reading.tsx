const timestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Cache refreshes do not change the time at which the provider actually reported usage. */
export function QuotaReading(props: { observedAt: number }) {
  if (!Number.isFinite(props.observedAt) || props.observedAt <= 0)
    return <p className="text-xs text-subtle-foreground">Provider reading time not reported</p>;
  return (
    <p className="text-xs text-subtle-foreground">
      Last provider reading:{" "}
      <time dateTime={new Date(props.observedAt).toISOString()}>
        {timestamp.format(props.observedAt)}
      </time>
    </p>
  );
}
