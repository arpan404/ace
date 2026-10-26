import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import type { Machine } from "@/lib/machines.ts";
import { LocationField, useLocation } from "@/features/projects/index.ts";

/**
 * Where a project the other machine doesn't have yet goes: its default folder, or, when this
 * window is connected to that machine, a folder chosen with Add project's location search.
 */
export function FolderChoice(props: {
  machine: Machine | undefined;
  name: string;
  onParent(parent: string | undefined): void;
}) {
  const [choosing, setChoosing] = useState(false);
  const { machine } = props;
  return (
    <div className="py-2">
      <div className="flex h-7 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-foreground">Folder</span>
        {!choosing && (
          <span className="truncate text-muted-foreground">Default folder on {props.name}</span>
        )}
        {machine && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              if (choosing) props.onParent(undefined);
              setChoosing(!choosing);
            }}
          >
            {choosing ? "Use default" : "Choose…"}
          </Button>
        )}
      </div>
      {choosing && machine && <Chooser machine={machine} onParent={props.onParent} />}
    </div>
  );
}

function Chooser(props: { machine: Machine; onParent(parent: string | undefined): void }) {
  const place = useLocation({ machine: props.machine });
  const { onParent } = props;
  useEffect(() => onParent(place.location), [place.location, onParent]);
  return (
    <div className="pt-2">
      <LocationField state={place} />
    </div>
  );
}
