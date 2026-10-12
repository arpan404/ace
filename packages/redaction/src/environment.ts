export interface EnvironmentSpan {
  start: number;
  end: number;
}
export interface EnvironmentMatcher {
  values: ReadonlySet<string>;
  spans(text: string): EnvironmentSpan[];
}
interface State {
  next: Map<string, State>;
  fail: State | undefined;
  longest: number;
}
const state = (): State => ({ next: new Map(), fail: undefined, longest: 0 });

/** Aho–Corasick over UTF-16 code units. The longest match ending at each
 * position contains all shorter matches there, so union coverage needs no
 * enumeration of suffix outputs. Scan work is linear in input length. */
export function createEnvironmentMatcher(values: readonly string[]): EnvironmentMatcher {
  const root = state();
  const spellings = new Set(values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]));
  for (const value of spellings) {
    if (!value.length) continue;
    let node = root;
    for (let i = 0; i < value.length; i++) {
      const char = value.charAt(i);
      let child = node.next.get(char);
      if (!child) {
        child = state();
        node.next.set(char, child);
      }
      node = child;
    }
    node.longest = Math.max(node.longest, value.length);
  }
  const queue = [...root.next.values()];
  for (const node of queue) node.fail = root;
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (!node) continue;
    for (const [char, child] of node.next) {
      let fallback = node.fail;
      while (fallback && !fallback.next.has(char)) fallback = fallback.fail;
      child.fail = fallback?.next.get(char) ?? root;
      child.longest = Math.max(child.longest, child.fail.longest);
      queue.push(child);
    }
  }
  return {
    values: new Set(values),
    spans(text) {
      if (!root.next.size) return [];
      const spans: EnvironmentSpan[] = [];
      let node = root;
      for (let i = 0; i < text.length; i++) {
        const char = text.charAt(i);
        while (node !== root && !node.next.has(char)) node = node.fail ?? root;
        node = node.next.get(char) ?? root;
        if (!node.longest) continue;
        let start = i + 1 - node.longest;
        // Matches arrive in end order. Each interval is pushed and popped at
        // most once, including when a later match starts before earlier ones.
        while (spans.length) {
          const previous = spans[spans.length - 1];
          if (!previous || previous.end <= start) break;
          start = Math.min(start, previous.start);
          spans.pop();
        }
        spans.push({ start, end: i + 1 });
      }
      return spans;
    },
  };
}
