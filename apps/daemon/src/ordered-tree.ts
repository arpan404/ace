interface Node<T> {
  item: T;
  left: Node<T> | undefined;
  right: Node<T> | undefined;
  height: number;
}

/**
 * A sorted set as an AVL tree: insert and remove cost O(log n), building from sorted items
 * costs O(n), and reading the first k items costs O(log n + k). `compare` must be a total
 * order; an item is removed by passing one that compares equal to it.
 */
export class OrderedTree<T> {
  private root: Node<T> | undefined;
  private count = 0;
  private readonly compare: (a: T, b: T) => number;
  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }
  get size(): number {
    return this.count;
  }
  /** Replace the contents with items already sorted by `compare`, without duplicates. */
  load(sorted: readonly T[]): void {
    const build = (low: number, high: number): Node<T> | undefined => {
      if (low >= high) return undefined;
      const middle = (low + high) >>> 1;
      const item = sorted[middle] as T;
      const left = build(low, middle);
      const right = build(middle + 1, high);
      return { item, left, right, height: 1 + Math.max(height(left), height(right)) };
    };
    this.root = build(0, sorted.length);
    this.count = sorted.length;
  }
  insert(item: T): void {
    this.root = this.add(this.root, item);
  }
  remove(item: T): void {
    this.root = this.delete(this.root, item);
  }
  /** The first `limit` items in order. */
  first(limit: number): T[] {
    const items: T[] = [];
    const stack: Node<T>[] = [];
    let node = this.root;
    while (items.length < limit && (node || stack.length)) {
      while (node) {
        stack.push(node);
        node = node.left;
      }
      const next = stack.pop();
      if (!next) break;
      items.push(next.item);
      node = next.right;
    }
    return items;
  }
  private add(node: Node<T> | undefined, item: T): Node<T> {
    if (!node) {
      this.count++;
      return { item, left: undefined, right: undefined, height: 1 };
    }
    const order = this.compare(item, node.item);
    if (order < 0) node.left = this.add(node.left, item);
    else if (order > 0) node.right = this.add(node.right, item);
    else node.item = item;
    return balance(node);
  }
  private delete(node: Node<T> | undefined, item: T): Node<T> | undefined {
    if (!node) return undefined;
    const order = this.compare(item, node.item);
    if (order < 0) node.left = this.delete(node.left, item);
    else if (order > 0) node.right = this.delete(node.right, item);
    else {
      this.count--;
      if (!node.left) return node.right;
      if (!node.right) return node.left;
      let successor = node.right;
      while (successor.left) successor = successor.left;
      node.item = successor.item;
      // The successor is removed from the right subtree; it is counted once, above.
      this.count++;
      node.right = this.delete(node.right, successor.item);
    }
    return balance(node);
  }
}

function height<T>(node: Node<T> | undefined): number {
  return node ? node.height : 0;
}
function update<T>(node: Node<T>): Node<T> {
  node.height = 1 + Math.max(height(node.left), height(node.right));
  return node;
}
function rotateRight<T>(node: Node<T>): Node<T> {
  const left = node.left as Node<T>;
  node.left = left.right;
  left.right = update(node);
  return update(left);
}
function rotateLeft<T>(node: Node<T>): Node<T> {
  const right = node.right as Node<T>;
  node.right = right.left;
  right.left = update(node);
  return update(right);
}
function balance<T>(node: Node<T>): Node<T> {
  update(node);
  const skew = height(node.left) - height(node.right);
  if (skew > 1) {
    const left = node.left as Node<T>;
    if (height(left.left) < height(left.right)) node.left = rotateLeft(left);
    return rotateRight(node);
  }
  if (skew < -1) {
    const right = node.right as Node<T>;
    if (height(right.right) < height(right.left)) node.right = rotateRight(right);
    return rotateLeft(node);
  }
  return node;
}
