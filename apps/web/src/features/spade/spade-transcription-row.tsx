import { splitSpadeModel, type SpadeModels } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { saveModel, setTranscriptionModel } from "./spade-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { modelsKey } from "./use-spade-models.ts";

/**
 * The transcription model (ADR 0134), which turns voice messages into words where the device
 * can't: any model on one of the person's endpoints, picked as a bot's model is. Picking one
 * saves it on its endpoint as able to transcribe; Turn off clears it.
 */
export function TranscriptionRow(props: { models: SpadeModels }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const id = useId();
  const current = props.models.transcriptionModel;
  // What the picker shows: an endpoint chosen before its model, else the saved choice.
  const [shown, setShown] = useState(current ?? "");
  const choose = async (value: string | null) => {
    try {
      if (value !== null) {
        const { endpoint, model } = splitSpadeModel(value);
        const saved = props.models.endpoints
          .find((each) => each.id === endpoint)
          ?.models.find((each) => each.id === model);
        if (!saved?.capabilities.includes("transcription"))
          await saveModel(client, endpoint, {
            id: model,
            ...(saved && saved.name !== saved.id ? { name: saved.name } : {}),
            ...(saved?.context ? { context: saved.context } : {}),
            capabilities: [...(saved?.capabilities ?? []), "transcription"],
          });
      }
      await setTranscriptionModel(client, value);
    } catch (error) {
      toast.error({
        title: "Couldn't change the transcription model",
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      await cache.invalidateQueries({ queryKey: modelsKey });
    }
  };
  return (
    <SettingRow
      title="Transcription"
      description="Turns voice messages into words when this device can't."
      htmlFor={id}
      density="compact"
    >
      <div className="flex w-96 max-w-full min-w-0 items-center gap-1">
        <SpadeModelPicker
          id={id}
          value={shown}
          onChange={(value) => {
            setShown(value);
            // Choosing an endpoint alone isn't a model yet.
            if (splitSpadeModel(value).model) void choose(value);
          }}
        />
        {current && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setShown("");
              void choose(null);
            }}
          >
            Turn off
          </Button>
        )}
      </div>
    </SettingRow>
  );
}
