import { ClientError, defaultLimits } from "@ace/client";

// Structured clone preserves aliases and cycles. Zod and JSON.stringify subsequently expand
// the graph as a tree, so bound that expansion before either sees a tab's arguments.
const maxDepth = 64;
const maxValues = 65_536;
const maxCharacters = defaultLimits.frameBytes;

interface Weight {
  values: number;
  characters: number;
  depth: number;
}
interface Frame extends Weight {
  object: object;
  children: Iterator<unknown>;
}

const limit = () => new ClientError("limit", "Worker arguments exceed the JSON workload limit");
const invalid = () => new ClientError("protocol", "Worker arguments must be acyclic JSON data");

function stringCharacters(value: string): number {
  if (value.length > maxCharacters) throw limit();
  // This serializes one bounded scalar, never the unadmitted object graph. UTF-8 frame
  // admission remains the connection's job; character count bounds parsing work here.
  return JSON.stringify(value).length;
}

function scalar(value: unknown): number | undefined {
  let characters: number;
  switch (typeof value) {
    case "string":
      characters = stringCharacters(value);
      break;
    case "number":
      characters = String(value).length;
      break;
    case "boolean":
      characters = value ? 4 : 5;
      break;
    case "undefined":
    case "object":
      if (value) return;
      characters = 4;
      break;
    default:
      throw invalid();
  }
  return characters;
}

function* children(resolve: () => Frame): Generator<unknown> {
  // Generator bodies start on next(), after the frame has been initialized.
  const frame = resolve();
  if (Array.isArray(frame.object)) {
    if (frame.object.length > maxValues) throw limit();
    for (const child of frame.object) {
      frame.characters++; // Commas, including one conservative extra comma.
      yield child;
    }
    return;
  }
  const prototype: unknown = Object.getPrototypeOf(frame.object);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  // Enumerate lazily rather than allocating an unbounded Object.entries array first.
  for (const key in frame.object) {
    if (!Object.hasOwn(frame.object, key)) continue;
    frame.characters += stringCharacters(key) + 2; // Colon and comma.
    yield Reflect.get(frame.object, key);
  }
}

function add(frame: Frame, values: number, characters: number, depth: number): void {
  frame.values += values;
  frame.characters += characters;
  frame.depth = Math.max(frame.depth, depth + 1);
  if (frame.values > maxValues || frame.characters > maxCharacters || frame.depth > maxDepth)
    throw limit();
}

/** Admit finite JSON work without recursively walking or expanding shared subgraphs. */
export function admitArguments(args: unknown[]): void {
  // Null marks an object on the current path; completed objects have a weight.
  const weights = new Map<object, Weight | null>();
  const stack: Frame[] = [];
  let unique = 0;
  const enter = (object: object) => {
    if (++unique > maxValues || stack.length >= maxDepth) throw limit();
    const frame: Frame = {
      object,
      children: children(() => frame),
      values: 1,
      characters: 2,
      depth: 0,
    };
    weights.set(object, null);
    stack.push(frame);
  };
  enter(args);
  for (;;) {
    const frame = stack.at(-1);
    if (!frame) return;
    const next = frame.children.next();
    if (next.done) {
      weights.set(frame.object, frame);
      stack.pop();
      const parent = stack.at(-1);
      if (parent) add(parent, frame.values, frame.characters, frame.depth);
      continue;
    }
    const value = next.value;
    const characters = scalar(value);
    if (characters !== undefined) {
      add(frame, 1, characters, 0);
      continue;
    }
    // scalar ruled out null and every non-object value.
    if (typeof value !== "object" || !value) throw invalid();
    const cached = weights.get(value);
    if (cached === null) throw invalid();
    if (cached) add(frame, cached.values, cached.characters, cached.depth);
    else enter(value);
  }
}
