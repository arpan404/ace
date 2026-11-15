import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";

/**
 * "‹ 1/3 ›": which of a card's questions shows, with Previous question and Next question to move
 * between them. An agent's question card in a thread and a Spade bot's card both page with it.
 * `canNext` is false until the question showing has an answer.
 */
export function QuestionPager(props: {
  index: number;
  count: number;
  canNext: boolean;
  onGo(index: number): void;
}) {
  const { index, count } = props;
  return (
    <span className="flex items-center gap-0.5 text-xs text-subtle-foreground tabular-nums">
      <IconButton
        size="sm"
        icon={CaretLeftIcon}
        label="Previous question"
        disabled={index === 0}
        onClick={() => props.onGo(index - 1)}
      />
      <span aria-label={`Question ${index + 1} of ${count}`}>
        {index + 1}/{count}
      </span>
      <IconButton
        size="sm"
        icon={CaretRightIcon}
        label="Next question"
        disabled={index === count - 1 || !props.canNext}
        onClick={() => props.onGo(index + 1)}
      />
    </span>
  );
}
