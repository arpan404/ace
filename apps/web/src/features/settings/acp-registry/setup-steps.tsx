import { registrySetup } from "@ace/ui-core/acp-registry";
import { CopyCommand } from "@/components/copy-command.tsx";

/**
 * Setting up an ACP agent: it signs in through its own CLI, never through ace (ADR 0002), so
 * this is the registry's hint as a command to copy, or as words when it isn't one.
 */
export function SetupSteps(props: { name: string; loginHint: string; titled?: boolean }) {
  const setup = registrySetup(props.loginHint);
  return (
    <p className="text-sm text-muted-foreground">
      {props.titled !== false && <span className="font-medium text-foreground">Set up · </span>}
      {props.name} signs in with its own CLI, never through ace.{" "}
      {setup.run ? (
        <>
          In a terminal on the computer running ace, run <CopyCommand command={setup.run} />
          {setup.prompt && (
            <>
              {" "}
              then type <span className="font-mono">{setup.prompt}</span>
            </>
          )}
          {setup.note && <> and {setup.note}</>}.
        </>
      ) : (
        `${setup.note?.replace(/\.$/, "")}.`
      )}
    </p>
  );
}
