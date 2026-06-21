export function sortedCopy<T>(
  values: ReadonlyArray<T>,
  compare: (left: T, right: T) => number,
): Array<T> {
  const result = [...values];
  for (let index = 1; index < result.length; index += 1) {
    const candidate = result[index];
    let insertionIndex = index - 1;
    while (insertionIndex >= 0 && compare(result[insertionIndex] as T, candidate as T) > 0) {
      result[insertionIndex + 1] = result[insertionIndex] as T;
      insertionIndex -= 1;
    }
    result[insertionIndex + 1] = candidate as T;
  }
  return result;
}
