import { expect, test } from "vitest";
import { attributeDroppedLine } from "./dropped-line.ts";

test.each([
  ['{"id":42,"result":"unfinished', { id: 42, response: true }],
  ['{"id":42,"result":{"text":"unfinished', { id: 42, response: true }],
  ['{"result":{"id":123,"text":"unfinished', { response: true }],
  ['{"id":"request\\\"42","error":{"message":"unfinished', { id: 'request"42', response: true }],
  [
    '{"method":"item/completed","params":{"threadId":"a","item":{"id":42,"text":"unfinished',
    { threadId: "a", response: false },
  ],
  ['{"padding":"fake \\\"id\\\":42', { response: false }],
  ['{"result":{},"id":42', { response: true }],
  ['{"result":{},"id":42e', { response: true }],
  ['{"id":"invalid\\x"', { response: false }],
])("only complete envelope fields can attribute a dropped line (%s)", (prefix, attributed) => {
  expect(attributeDroppedLine(prefix)).toEqual(attributed);
});
