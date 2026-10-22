/**
 * One block rhythm for a run of blocks (an answer, a quote, a loose list item): 12px between
 * blocks, 24px above a heading, and nothing above the first block, so an answer that opens with
 * a heading starts flush with its row.
 */
export const blockRhythm =
  "[&>*+*]:mt-3 [&>h3]:mt-6 [&>h4]:mt-6 [&>h5]:mt-6 [&>h6]:mt-6 [&>*:first-child]:mt-0";
