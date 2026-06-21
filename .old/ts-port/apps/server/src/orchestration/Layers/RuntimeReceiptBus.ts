import { Effect, Layer, PubSub, Stream } from "effect";

import { readPositiveIntegerEnv } from "../../resourceLimits.ts";
import {
  RuntimeReceiptBus,
  type RuntimeReceiptBusShape,
  type OrchestrationRuntimeReceipt,
} from "../Services/RuntimeReceiptBus.ts";

const RUNTIME_RECEIPT_BUS_CAPACITY = readPositiveIntegerEnv({
  envVarName: "ACE_RUNTIME_RECEIPT_BUS_CAPACITY",
  fallback: 4_096,
  minimum: 128,
});

const makeRuntimeReceiptBus = Effect.gen(function* () {
  const pubSub = yield* PubSub.bounded<OrchestrationRuntimeReceipt>(RUNTIME_RECEIPT_BUS_CAPACITY);

  return {
    publish: (receipt) => PubSub.publish(pubSub, receipt).pipe(Effect.asVoid),
    stream: Stream.fromPubSub(pubSub),
  } satisfies RuntimeReceiptBusShape;
});

export const RuntimeReceiptBusLive = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBus);
