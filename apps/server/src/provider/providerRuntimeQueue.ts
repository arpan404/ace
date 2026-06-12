import type { ProviderRuntimeEvent } from "@ace/contracts";
import { PubSub, Queue } from "effect";

import { readPositiveIntegerEnv } from "../resourceLimits.ts";

const DEFAULT_PROVIDER_ADAPTER_RUNTIME_EVENT_QUEUE_CAPACITY = 8_192;

export const makeProviderAdapterRuntimeEventQueue = () =>
  Queue.bounded<ProviderRuntimeEvent>(
    readPositiveIntegerEnv({
      envVarName: "ACE_PROVIDER_ADAPTER_RUNTIME_EVENT_QUEUE_CAPACITY",
      fallback: DEFAULT_PROVIDER_ADAPTER_RUNTIME_EVENT_QUEUE_CAPACITY,
      minimum: 256,
    }),
  );

export const makeProviderAdapterRuntimeEventPubSub = () =>
  PubSub.bounded<ProviderRuntimeEvent>(
    readPositiveIntegerEnv({
      envVarName: "ACE_PROVIDER_ADAPTER_RUNTIME_EVENT_PUBSUB_CAPACITY",
      fallback: DEFAULT_PROVIDER_ADAPTER_RUNTIME_EVENT_QUEUE_CAPACITY,
      minimum: 256,
    }),
  );
