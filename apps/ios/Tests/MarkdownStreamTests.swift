import Testing
@testable import Ace

@Suite struct MarkdownStreamTests {
    private let answer = """
    ## Result
    Orphan cleanup now records the **start time**
    and owner.

    - `ace stop` interrupts the tree
    - `ace stop --all` keeps to our processes
      started by ace

    | Area | Result |
    | --- | --- |
    | UI | **Fixed** |

    ```ts
    if (owner.startedAt !== kernel.startedAt) return;

    kill(pid);
    ```
    > Never kill a reused PID.

    ---
    3. Third
    4. Fourth

    A closing paragraph that keeps on streaming
    """

    @Test func everyStreamedPrefixParsesAsTheWholeTextWould() {
        let stream = MarkdownStream()
        var shown = ""
        for character in answer {
            shown.append(character)
            #expect(stream.update(shown).map(\.block) == Markdown.blocks(shown), "after \(shown.count) characters")
        }
    }
    @Test func aSlidingWindowParsesAsTheWholeWindowWould() {
        let stream = MarkdownStream()
        let message = String(repeating: answer + "\n\n", count: 6)
        let bytes = Array(message.utf8)
        // A 300-byte window that slides forward by 7 bytes per delta, cut at ASCII bytes only.
        for end in stride(from: 300, to: bytes.count, by: 7) {
            let window = String(decoding: bytes[(end - 300)..<end], as: UTF8.self)
            #expect(stream.update(window).map(\.block) == Markdown.blocks(window), "window ending at \(end)")
        }
    }
    @Test func appendingADeltaParsesOnlyTheLastBlock() {
        let stream = MarkdownStream()
        stream.update(answer)
        let before = stream.blocks
        let blocks = stream.update(answer + " and more")
        #expect(blocks.map(\.block) == Markdown.blocks(answer + " and more"))
        // Only the streaming paragraph was read again.
        #expect(stream.parsed < 60)
        #expect(Array(blocks.dropLast()) == Array(before.dropLast()))
        #expect(blocks.last?.id == before.last?.id)
    }
    @Test func blocksKeepTheirIdsWhileTheFrontOfTheWindowSlidesOff() {
        let stream = MarkdownStream()
        let message = String(repeating: "First paragraph line.\n\n- an item\n\nA later paragraph.\n\n", count: 20)
        let first = stream.update(String(message.dropLast(300)))
        let second = stream.update(String(message.dropFirst(30).dropLast(290)))
        #expect(second.map(\.block) == Markdown.blocks(String(message.dropFirst(30).dropLast(290))))
        // The cut paragraph at the front changes; the blocks after it keep their ids and text.
        let earlier = Dictionary(uniqueKeysWithValues: first.map { ($0.id, $0.block) })
        for block in second.dropFirst().dropLast() { #expect(earlier[block.id] == block.block) }
        #expect(stream.parsed < 120)
    }
    @Test func unrelatedTextIsParsedWholeUnderNewIds() {
        let stream = MarkdownStream()
        let first = stream.update("One paragraph.\n\nAnother.")
        let second = stream.update("Something else entirely.")
        #expect(second.map(\.block) == [.paragraph("Something else entirely.")])
        #expect(Set(first.map(\.id)).isDisjoint(with: second.map(\.id)))
    }
}
