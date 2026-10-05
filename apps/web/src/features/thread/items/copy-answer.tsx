import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";

/** Copies the answer's markdown, as written, with a moment of "Copied". */
export function CopyAnswer(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const copy = () =>
    void navigator.clipboard?.writeText(props.text).then(
      () => {
        setCopied(true);
        clearTimeout(reset.current);
        reset.current = setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  return (
    <IconButton
      icon={copied ? CheckIcon : CopyIcon}
      label={copied ? "Copied" : "Copy answer"}
      size="sm"
      onClick={copy}
    />
  );
}
