import { ForgeProse } from "./rich/forge-prose.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";

type Props = {
  text: string;
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  onOpen(number: number): void;
  /** Saves the text with one task box ticked, when the viewer may edit it. */
  tasks?: ((next: string) => Promise<boolean>) | undefined;
};
/** PR text (description, check output) as plain markit prose. */
export function PrMarkdown(props: Props) {
  return <ForgeProse text={props.text} className="text-ui leading-normal text-muted-foreground" />;
}
