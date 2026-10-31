import type { ReactNode } from "react";
import { Prose } from "@/components/markdown/prose.tsx";

/**
 * Text people wrote on a pull request or issue (descriptions, comments, reviews).
 * Renders through the shared markit renderer as plain prose.
 */
export function ForgeProse(props: {
  text: string;
  className?: string | undefined;
  link?: unknown | undefined;
  reference?: unknown | undefined;
  tasks?: ((next: string) => Promise<boolean>) | undefined;
}): ReactNode {
  return <Prose text={props.text} {...(props.className ? { className: props.className } : {})} />;
}
