import type { Toolchain } from "@ace/protocol";
import type { ReactNode } from "react";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { toolchainRow } from "@ace/ui-core";
import { toolchainNames, useToolchains } from "@/features/diagnostics/index.ts";

type ToolId = Toolchain["id"];

/**
 * The machine's tools a page relies on (`ids`, in that order), each Ready or Not installed, with
 * how to get a missing one: its hint, where to download it, or its `fixes` entry when ace can
 * get it itself (shown, and so mounted, only while the tool is missing).
 */
export function ToolchainSection(props: {
  label: string;
  /** The section's id, so a link can land on it (`#tools`). */
  anchor?: string;
  ids: readonly ToolId[];
  fixes?: Partial<Record<ToolId, ReactNode>>;
}) {
  const tools = useToolchains();
  const shown = props.ids.flatMap((id) => tools.data?.find((tool) => tool.id === id) ?? []);
  return (
    <SettingSection
      {...(props.anchor ? { anchor: props.anchor } : {})}
      label={props.label}
      actions={
        tools.data && (
          <Button
            variant="ghost"
            size="sm"
            disabled={tools.isFetching}
            onClick={() => void tools.refetch()}
          >
            Check again
          </Button>
        )
      }
    >
      {tools.isError ? (
        <SettingNote role="alert">
          Couldn't check the tools.{" "}
          <Button variant="ghost" size="sm" onClick={() => void tools.refetch()}>
            Try again
          </Button>
        </SettingNote>
      ) : !tools.data ? (
        <SettingRow title={toolchainNames[props.ids[0] ?? "git"]}>
          <Skeleton className="h-5 w-20 rounded-md" />
        </SettingRow>
      ) : (
        shown.map((tool) => <ToolRow key={tool.id} tool={tool} fix={props.fixes?.[tool.id]} />)
      )}
    </SettingSection>
  );
}

function ToolRow(props: { tool: Toolchain; fix: ReactNode }) {
  const row = toolchainRow(props.tool);
  const { installer } = row;
  return (
    <SettingRow
      title={row.name}
      description={
        row.ready ? (
          row.detail
        ) : (
          <>
            {row.detail}
            {installer && (
              <>
                {" "}
                <a
                  href={installer.href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-link focus-ring hover:underline"
                >
                  {installer.label}
                </a>
              </>
            )}
          </>
        )
      }
      inline
    >
      {!row.ready && props.fix}
      <StatusLabel tone={row.ready ? "done" : "idle"} label={row.status} />
    </SettingRow>
  );
}
