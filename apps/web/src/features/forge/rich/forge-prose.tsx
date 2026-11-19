import { hostedReferenceAddress } from "@ace/ui-core";
import { useCallback, useContext, type ReactNode } from "react";
import { forgeReferenceAddress } from "@ace/ui-core/forge-rich";
import { Prose } from "@/components/markdown/prose.tsx";
import { ForgeContentScope } from "./scope.ts";

/**
 * Text people wrote on a pull request or issue (descriptions, comments, reviews), rendered by
 * markit as GitHub draws it: `#123`, `@name` and commit hashes link into the page's repository
 * (`ForgeContentScope`). An issue or pull request they name opens ace's page where the screen
 * has one; anything else opens on the forge.
 */
export function ForgeProse(props: {
  text: string;
  className?: string | undefined;
  link?: unknown | undefined;
  reference?: unknown | undefined;
  tasks?: ((next: string) => Promise<boolean>) | undefined;
}): ReactNode {
  const repository = useContext(ForgeContentScope)?.repository;
  const { host, owner, name } = repository ?? {};
  const forgeReference = useCallback(
    (reference: { kind: string; target: string }) =>
      repository && repository.forge !== "github"
        ? hostedReferenceAddress(reference, repository)
        : forgeReferenceAddress(
            reference,
            host && owner && name ? { host, owner, name } : undefined,
          ),
    [host, owner, name, repository],
  );
  return (
    <Prose
      text={props.text}
      forgeReference={forgeReference}
      {...(props.className ? { className: props.className } : {})}
    />
  );
}
