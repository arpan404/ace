import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { StripSurface } from "@/features/thread/index.ts";
import { readLiveModels, setSpeechModel, setTranscriptionModel } from "./spade-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault } from "./spade-settings-rows.tsx";
import {
  voiceEndpoints,
  voiceModelChoices,
  type VoiceModelChoice,
  type VoiceRole,
} from "./spade-voice-models.ts";
import { modelsKey, useSpadeModels } from "./use-spade-models.ts";

/**
 * The person's models that can do `role`, from their saved facts and each usable endpoint's own
 * list. Reads the lists only while `enabled`; they share the cache the model pickers fill.
 */
export function useVoiceModelChoices(role: VoiceRole, enabled: boolean) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const models = useSpadeModels(enabled);
  const endpoints = voiceEndpoints(models.data?.endpoints ?? []);
  const lists = useQueries({
    queries: endpoints.map((endpoint) => ({
      queryKey: [...modelsKey, machine, "live", endpoint.id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        readLiveModels(client, endpoint.id, { signal }),
      enabled,
      staleTime: 60_000,
      retry: false,
    })),
  });
  const live = new Map(endpoints.map((endpoint, at) => [endpoint.id, lists[at]?.data ?? []]));
  return {
    choices: voiceModelChoices(role, models.data?.endpoints ?? [], live),
    loading: models.isPending || lists.some((list) => list.isPending && list.fetchStatus !== "idle"),
  };
}

/** Saves the choice as the model for `role`, and reads the models again. */
export function useChooseVoiceModel(role: VoiceRole) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  return async (model: string) => {
    await (role === "transcription"
      ? setTranscriptionModel(client, model)
      : setSpeechModel(client, model));
    await cache.invalidateQueries({ queryKey: modelsKey });
  };
}

/**
 * Above the composer when the person reached for the mic and nothing here can turn speech into
 * words yet: one button per endpoint of theirs that can, or one plain sentence when none can,
 * with the way to add one.
 */
export function TranscriptionSetup(props: { onChosen(): void; onClose(): void }) {
  const { choices, loading } = useVoiceModelChoices("transcription", true);
  const choose = useChooseVoiceModel("transcription");
  const navigate = useNavigate();
  const [choosing, setChoosing] = useState<string>();
  const [refusal, setRefusal] = useState<string>();
  const pick = async (choice: VoiceModelChoice) => {
    setChoosing(choice.model);
    setRefusal(undefined);
    try {
      await choose(choice.model);
      props.onChosen();
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setChoosing(undefined);
    }
  };
  return (
    <StripSurface slot="voice" variant="setup">
      <div role="status" className="flex min-w-0 flex-col gap-1.5 px-1 py-1 text-xs">
        {loading ? (
          <span className="flex h-7 items-center gap-1.5 text-foreground">
            <Spinner />
            Looking for a model that turns speech into words…
          </span>
        ) : choices.length > 0 ? (
          <>
            <span className="text-foreground">
              Choose how to turn speech into words. The recording goes only to the endpoint you
              pick.
            </span>
            <span className="flex flex-wrap items-center gap-1">
              {choices.map((choice) => (
                <Button
                  key={choice.model}
                  size="xs"
                  variant="secondary"
                  disabled={choosing !== undefined}
                  onClick={() => void pick(choice)}
                >
                  {`Use ${choice.endpointName} · ${choice.modelName}`}
                </Button>
              ))}
              <Button size="xs" variant="ghost" onClick={props.onClose}>
                Not now
              </Button>
            </span>
          </>
        ) : (
          <>
            <span className="text-foreground">
              None of your endpoints turns speech into words, and this app can't on its own. Add
              an OpenAI-format endpoint with a transcription model, such as OpenAI's whisper-1.
            </span>
            <span className="flex flex-wrap items-center gap-1">
              <Button
                size="xs"
                variant="secondary"
                onClick={() => void navigate({ to: "/settings/spade/models" })}
              >
                Open Models
              </Button>
              <Button size="xs" variant="ghost" onClick={props.onClose}>
                Not now
              </Button>
            </span>
          </>
        )}
        {refusal && (
          <span role="alert" className="text-destructive">
            {refusal}
          </span>
        )}
      </div>
    </StripSurface>
  );
}
