import { CircleDashedIcon } from "@phosphor-icons/react";

/**
 * Waiting on agents: the working mark's dashed circle (Phosphor `CircleDashed`, bold) holding how
 * many agents the thread waits on, 1 to 9 in bold tabular figures. Above 9, or with no count, a
 * small dot sits inside instead. Decorative: the row's status names the count in words
 * ("Waiting on 3 agents").
 */
export function WaitingCountMark(props: { count: number | undefined; size?: number | undefined }) {
  const size = props.size ?? 16;
  const { count } = props;
  const digit = count !== undefined && count >= 1 && count <= 9 ? count : undefined;
  return (
    <span
      className="relative inline-grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <CircleDashedIcon size={size} weight="bold" className="absolute inset-0" />
      {digit !== undefined ? (
        <span
          data-count={digit}
          className="relative leading-none font-bold tabular-nums"
          style={{ fontSize: Math.round(size * 0.5) }}
        >
          {digit}
        </span>
      ) : (
        <span
          data-count="many"
          className="relative rounded-full bg-current"
          style={{ width: size * 0.18, height: size * 0.18 }}
        />
      )}
    </span>
  );
}
