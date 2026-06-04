import { memo, type ComponentProps } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

export const MessageCopyButton = memo(function MessageCopyButton(props: {
  text: string;
  className?: string;
  size?: ComponentProps<typeof Button>["size"];
  variant?: ComponentProps<typeof Button>["variant"];
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const variant = props.variant ?? "outline";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size={props.size ?? "xs"}
            variant={variant}
            className={cn(
              "transition-all duration-200",
              variant === "outline" && "border-border/40 hover:border-border/60",
              props.className,
            )}
            onClick={() => copyToClipboard(props.text)}
            aria-label={isCopied ? "Copied" : "Copy message"}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{isCopied ? "Copied" : "Copy message"}</TooltipPopup>
    </Tooltip>
  );
});
