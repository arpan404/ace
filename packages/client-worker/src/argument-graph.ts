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

function scalar(value: unknown): Weight | undefined {
  switch (typeof value) {
    case "string":
      return { values: 1, characters: stringCharacters(value), depth: 0 };
    case "number":
      return { values: 1, characters: String(value).length, depth: 0 };
    case "boolean":
      return { values: 1, characters: value ? 4 : 5, depth: 0 };
    case "undefined":
      return { values: 1, characters: 4, depth: 0 };
    case "object":
      return value === null ? { values: 1, characters: 4, depth: 0 } : undefined;
    default:
      throw invalid();
  }
}

function* children(frame: Frame): Generator<unknown> {
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

function add(frame: Frame, weight: Weight): void {
  frame.values += weight.values;
  frame.characters += weight.characters;
  frame.depth = Math.max(frame.depth, weight.depth + 1);
  if (frame.values > maxValues || frame.characters > maxCharacters || frame.depth > maxDepth)
    throw limit();
}

/** Admit finite JSON work without recursively walking or expanding shared subgraphs. */
export function admitArguments(args: unknown[]): void {
  const weights = new Map<object, Weight>();
  const visiting = new Set<object>();
  const stack: Frame[] = [];
  let unique = 0;
  const enter = (object: object) => {
    if (++unique > maxValues || stack.length >= maxDepth) throw limit();
    const frame: Frame = {
      object,
      children: [][Symbol.iterator](),
      values: 1,
      characters: 2,
      depth: 0,
    };
    frame.children = children(frame);
    visiting.add(object);
    stack.push(frame);
  };
  enter(args);
  for (;;) {
    const frame = stack.at(-1);
    if (!frame) return;
    const next = frame.children.next();
    if (next.done) {
      weights.set(frame.object, frame);
      visiting.delete(frame.object);
      stack.pop();
      const parent = stack.at(-1);
      if (parent) add(parent, frame);
      continue;
    }
    const weight = scalar(next.value);
    if (weight) {
      add(frame, weight);
      continue;
    }
    // scalar ruled out null and every non-object value.
    if (typeof next.value !== "object" || next.value === null) throw invalid();
    if (visiting.has(next.value)) throw invalid();
    const cached = weights.get(next.value);
    if (cached) add(frame, cached);
    else enter(next.value);
  }
}
