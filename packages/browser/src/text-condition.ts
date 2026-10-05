/** Bound every visible-text probe before allocating or matching page text. These are work
 * budgets, not timings: measured latency and memory still need the merge-time benchmark. */
export const textWaitMaxNodes = 1024;
export const textWaitMaxCharacters = 65_536;
export function textCondition(text: string): string {
  return `(() => {
    if (document.readyState === 'loading' || !document.body) return {matched:false, limited:false};
    const search = ${JSON.stringify(text)};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ALL);
    let node, nodes=0, characters=0, tail='';
    while ((node = walker.nextNode())) {
      if (++nodes > ${textWaitMaxNodes}) return {matched:false, limited:true};
      if (node.nodeType !== Node.TEXT_NODE || !node.parentElement) continue;
      if (['SCRIPT','STYLE','NOSCRIPT'].includes(node.parentElement.tagName)) continue;
      const value = node.nodeValue ?? '';
      if (characters + value.length > ${textWaitMaxCharacters}) return {matched:false, limited:true};
      characters += value.length;
      const range = document.createRange(); range.selectNodeContents(node);
      if (!range.getClientRects().length || getComputedStyle(node.parentElement).visibility === 'hidden') continue;
      const content = tail + value;
      if (content.includes(search)) return {matched:true, limited:false};
      tail = search.length > 1 ? content.slice(1 - search.length) : '';
    }
    return {matched:false, limited:false};
  })()`;
}
