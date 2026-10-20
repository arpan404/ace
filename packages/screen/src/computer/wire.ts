/*
 * Replies from `ace-screen-helper --computer`. Parsed leniently: unknown fields are kept,
 * optional ones may be missing, so a newer helper never breaks an older daemon.
 */
import { z } from "zod";

export const ComputerNode = z.looseObject({
  id: z.number().int(),
  depth: z.number().int().min(0),
  role: z.string(),
  flags: z.array(z.string()).optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  detail: z.string().optional(),
  placeholder: z.string().optional(),
  url: z.string().optional(),
  actions: z.array(z.string()).optional(),
});
export type ComputerNode = z.infer<typeof ComputerNode>;

export const ComputerState = z.looseObject({
  app: z.looseObject({
    name: z.string(),
    bundleId: z.string(),
    pid: z.number().int(),
    active: z.boolean().optional(),
    hidden: z.boolean().optional(),
  }),
  windows: z
    .array(
      z.looseObject({
        index: z.number().int(),
        title: z.string(),
        onScreen: z.boolean().optional(),
        minimized: z.boolean().optional(),
        current: z.boolean().optional(),
        otherSpace: z.boolean().optional(),
      }),
    )
    .default([]),
  window: z
    .looseObject({
      title: z.string(),
      width: z.number(),
      height: z.number(),
      onScreen: z.boolean().optional(),
    })
    .optional(),
  nodes: z.array(ComputerNode).default([]),
  truncated: z.boolean().default(false),
  menuBar: z.array(z.string()).default([]),
  focused: z
    .looseObject({
      id: z.number().int().optional(),
      role: z.string().optional(),
      name: z.string().optional(),
      selectedText: z.string().optional(),
    })
    .optional(),
  launched: z.boolean().optional(),
  /** The launch brought the app to the front and the helper put the person's app back. */
  front: z.string().optional(),
  screenshot: z
    .looseObject({ jpeg: z.string(), width: z.number().int(), height: z.number().int() })
    .optional(),
  screenshotError: z.string().optional(),
  /** The app stopped answering accessibility requests; the outline may be partial. */
  notResponding: z.boolean().optional(),
  /** How long the helper took; for diagnostics, never shown to the model. */
  elapsedMs: z.number().optional(),
});
export type ComputerState = z.infer<typeof ComputerState>;

export const ComputerActResult = z.looseObject({
  done: z.array(z.string()).default([]),
  error: z
    .looseObject({ index: z.number().int(), code: z.string(), message: z.string() })
    .optional(),
  state: ComputerState.optional(),
});
export type ComputerActResult = z.infer<typeof ComputerActResult>;

export const ComputerApps = z.looseObject({
  apps: z.array(
    z.looseObject({
      name: z.string(),
      bundleId: z.string(),
      running: z.boolean(),
      active: z.boolean().optional(),
    }),
  ),
});
export type ComputerApps = z.infer<typeof ComputerApps>;

/** `hello`: the helper's protocol version, its macOS grants and what it can do. */
export const ComputerHello = z.looseObject({
  version: z.number().int().default(1),
  accessibility: z.boolean().optional(),
  screenRecording: z.boolean().optional(),
  capabilities: z.array(z.string()).default([]),
});
export type ComputerHello = z.infer<typeof ComputerHello>;

export const ComputerReply = z.union([
  z.looseObject({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.looseObject({
    id: z.string(),
    ok: z.literal(false),
    error: z.looseObject({ code: z.string(), message: z.string() }),
  }),
]);
