import Testing
@testable import Ace

/// A file too large to show whole: each part gives back exactly the text it was read as (BOM and
/// CRLF included, so a save covers exactly its bytes), at most a window of parts is held however
/// far reading goes, and find searches the file a page at a time, reaching every match however
/// many there are.
@Suite struct LargeFileTextTests {
    /// A file as pages of `lines` lines each, every line "row N" (with "hit" on rows in `hits`).
    private func pages(_ count: Int, lines: Int = 3, hits: Set<Int> = []) -> [FilePageAnswer] {
        var offset = 0
        var out: [FilePageAnswer] = []
        var texts: [String] = []
        for page in 0..<count {
            texts.append((0..<lines).map { line in
                let row = page * lines + line
                return hits.contains(row) ? "row \(row) hit\n" : "row \(row)\n"
            }.joined())
        }
        let size = texts.reduce(0) { $0 + $1.utf8.count }
        for (index, text) in texts.enumerated() {
            out.append(FilePageAnswer(text: text, offset: offset, nextOffset: offset + text.utf8.count, size: size, version: "v1", done: index == count - 1))
            offset += text.utf8.count
        }
        return out
    }

    @Test func aPartGivesBackItsTextExactlyWithItsBOMAndCRLFLines() {
        let text = "\u{FEFF}alpha\r\nbeta\r\n\r\n"
        var reading = LargeFileText()
        reading.take(FilePageAnswer(text: text, offset: 0, nextOffset: text.utf8.count, size: text.utf8.count + 5, version: "v1", done: false))
        let part = reading.parts[0]
        #expect(part.text.utf8.elementsEqual(text.utf8))
        // Lines split at each line feed, so CRLF files number their lines.
        #expect(part.lines.count == 3)
        #expect(reading.starts.last == LargeFileText.Start(offset: text.utf8.count, firstLine: 3))
    }

    @Test func readingOnHoldsAWindowOfPartsAndReadsBackFromKnownStarts() {
        let file = pages(LargeFileText.window + 4)
        var reading = LargeFileText()
        for page in file { reading.take(page) }
        #expect(reading.parts.count == LargeFileText.window)
        #expect(reading.parts.first?.offset == file[4].offset)
        #expect(reading.parts.first?.firstLine == 12)
        #expect(reading.done && reading.hasEarlier)
        // The page before the window is known, and reading it back lets the last part go.
        #expect(reading.earlierStart == file[3].offset)
        reading.takeEarlier(file[3])
        #expect(reading.parts.first?.firstLine == 9 && reading.parts.count == LargeFileText.window && !reading.done)
    }

    @Test func aJumpShowsOnePartAtItsLineAndReadingGoesOnFromThere() {
        let file = pages(10)
        var reading = LargeFileText()
        reading.take(file[0])
        reading.jump(to: file[7], firstLine: 21)
        reading.take(file[8])
        #expect(reading.parts.map(\.firstLine) == [21, 24])
        #expect(reading.hasEarlier)
    }

    @Test func aSearchWithNoMatchReadsEachPageOnceAndHoldsNoText() {
        var search = FileSearch(query: "missing")
        var taken = 0
        for page in pages(50) where search.next?.page == page.offset { search.take(page); taken += 1 }
        #expect(taken == 50)
        #expect(search.complete && search.found == 0)
        #expect(FindStep.next(from: nil, in: search) == FindStep.none)
    }

    @Test func matchesPastTheBatchLimitStayReachableByNext() {
        // Every row matches; batches of 4 over 30 rows.
        let file = pages(10, hits: Set(0..<30))
        var search = FileSearch(query: "hit", limit: 4)
        var current: Int?
        var reached: [Int] = []
        steps: for _ in 0..<200 {
            switch FindStep.next(from: current, in: search) {
            case .show(let index):
                // Round to the first again: every match has been shown.
                if let current, index <= current { break steps }
                guard let hit = search.hit(index) else { Issue.record("match \(index) isn't held"); return }
                reached.append(hit.line)
                current = index
            case .search(let advance):
                if advance { search.advance() }
                if let next = search.next, let page = file.first(where: { $0.offset == next.page }) { search.take(page) }
            case .rewind, .none:
                break steps
            }
        }
        #expect(reached == Array(0..<30))
        #expect(search.complete && search.found == 30)
    }

    @Test func previousBeforeTheBatchHeldSearchesAgainFromTheStart() {
        let file = pages(4, hits: Set(0..<12))
        var search = FileSearch(query: "hit", limit: 4)
        for page in file where search.next?.page == page.offset { search.take(page) }
        #expect(search.full && search.found == 4)
        search.advance()
        for page in file where search.next?.page == page.offset { search.take(page) }
        #expect(search.hit(4)?.line == 4 && search.hit(3) == nil)
        #expect(FindStep.previous(from: 4, in: search) == .rewind(to: 3))
        search.rewind()
        for page in file where search.next?.page == page.offset { search.take(page) }
        #expect(search.hit(3)?.line == 3)
    }

    @Test func aMatchKnowsItsPageAndThatPagesFirstLine() {
        let file = pages(5, hits: [13])
        var search = FileSearch(query: "HIT")
        for page in file where search.next?.page == page.offset { search.take(page) }
        #expect(search.hits == [FileSearch.Hit(page: file[4].offset, pageLine: 12, line: 13, column: 7)])
    }
}
