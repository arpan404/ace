import Foundation

/// One page of a file too large to show whole (`bridge/checkout-pages.ts`): its text from a byte
/// offset, ending after a line break, and where the next page starts.
struct FilePageAnswer: Decodable, Sendable, Equatable {
    let text: String
    let offset: Int
    let nextOffset: Int
    let size: Int
    let version: String
    let done: Bool
}

/// A page's text as lines, split on line feeds only (a CRLF line keeps its `\r`), so the lines
/// joined with `\n`, plus the break it ended with, are exactly the text it came as.
struct PageLines: Equatable {
    let lines: [String]
    let endsWithBreak: Bool

    init(_ text: String) {
        let scalars = text.unicodeScalars
        var lines: [String] = []
        var start = scalars.startIndex
        var index = scalars.startIndex
        while index < scalars.endIndex {
            if scalars[index] == "\n" {
                lines.append(String(scalars[start..<index]))
                start = scalars.index(after: index)
            }
            index = scalars.index(after: index)
        }
        let tail = String(scalars[start...])
        endsWithBreak = !text.isEmpty && tail.isEmpty
        if !tail.isEmpty { lines.append(tail) }
        self.lines = lines
    }

    var text: String { lines.joined(separator: "\n") + (endsWithBreak ? "\n" : "") }
}

/// What is shown of a large file: at most `window` parts in a row, from wherever reading or a
/// find jumped to. Reading on past the window lets its first part go, so the phone holds a few
/// parts however long the file is. Each part keeps the bytes it covers, so it can be edited on
/// its own and saved over exactly those bytes. Pure.
struct LargeFileText: Equatable {
    struct Part: Identifiable, Equatable {
        /// The bytes of the file the part covers: `[offset, end)`.
        let offset: Int
        let end: Int
        /// The 0-based line number of its first line in the file (the line it starts in, which a
        /// part after a cut long line shares with the part before).
        let firstLine: Int
        let lines: [String]
        /// The part's text ended with a line break (every part but a file's last one does).
        let endsWithBreak: Bool
        /// The part ends the file.
        let last: Bool
        var id: Int { offset }
        var length: Int { end - offset }
        /// The part's text exactly as read, for editing it.
        var text: String { PageLines(lines: lines, endsWithBreak: endsWithBreak).text }
        /// The part as the page it was read as, for searching it without reading it again.
        func page(size: Int, version: String) -> FilePageAnswer {
            FilePageAnswer(text: text, offset: offset, nextOffset: end, size: size, version: version, done: last)
        }
    }
    /// Where a page starts and its first line, as far as the file has been read or searched.
    struct Start: Equatable { let offset: Int; let firstLine: Int }

    /// Parts held at once (about 256 KB each).
    static let window = 8

    private(set) var parts: [Part] = []
    private(set) var version: String?
    private(set) var size = 0
    /// Every page start seen, in order: the chain from the file's start as far as it is known.
    private(set) var starts: [Start] = [Start(offset: 0, firstLine: 0)]

    /// The last part held is the file's end.
    var done: Bool { parts.last?.last ?? false }
    /// Where the next part after the window starts.
    var next: Int { parts.last?.end ?? 0 }
    /// Parts before the window were let go (or never read).
    var hasEarlier: Bool { (parts.first?.offset ?? 0) > 0 }
    /// The share of the file the window reaches, 0–99 until the end.
    var percent: Int { done ? 100 : size > 0 ? min(99, next * 100 / size) : 0 }

    /// Add the page that follows the window; the first part goes once more than `window` are held.
    mutating func take(_ page: FilePageAnswer) {
        guard page.offset == next, let first = startLine(page.offset) else { return }
        append(page, firstLine: first)
        if parts.count > Self.window { parts.removeFirst() }
    }

    /// Add the page just before the window; the last part goes once more than `window` are held.
    mutating func takeEarlier(_ page: FilePageAnswer) {
        guard let first = parts.first, page.nextOffset == first.offset, let line = startLine(page.offset) else { return }
        let lines = PageLines(page.text)
        parts.insert(Part(offset: page.offset, end: page.nextOffset, firstLine: line, lines: lines.lines,
                          endsWithBreak: lines.endsWithBreak, last: page.done), at: 0)
        if parts.count > Self.window { parts.removeLast() }
    }

    /// Show from `page` alone (a find's match far from the window), its first line known.
    mutating func jump(to page: FilePageAnswer, firstLine: Int) {
        learn(Start(offset: page.offset, firstLine: firstLine))
        parts = []
        append(page, firstLine: firstLine)
    }

    /// Where the page before the window starts, once it is known.
    var earlierStart: Int? {
        guard let first = parts.first, let index = starts.firstIndex(where: { $0.offset == first.offset }), index > 0 else { return nil }
        return starts[index - 1].offset
    }

    /// A page start a search found, so the window can jump there and read back from it.
    mutating func learn(_ start: Start) {
        guard !starts.contains(start) else { return }
        let index = starts.firstIndex { $0.offset > start.offset } ?? starts.endIndex
        starts.insert(start, at: index)
    }

    private func startLine(_ offset: Int) -> Int? { starts.first { $0.offset == offset }?.firstLine }

    private mutating func append(_ page: FilePageAnswer, firstLine: Int) {
        let lines = PageLines(page.text)
        parts.append(Part(offset: page.offset, end: page.nextOffset, firstLine: firstLine, lines: lines.lines,
                          endsWithBreak: lines.endsWithBreak, last: page.done))
        version = page.version
        size = page.size
        // A page that ends inside a line (one longer than a page) leaves the next page in it.
        let carried = lines.endsWithBreak || lines.lines.isEmpty ? 0 : 1
        if !page.done { learn(Start(offset: page.nextOffset, firstLine: firstLine + lines.lines.count - carried)) }
    }
}

extension PageLines {
    init(lines: [String], endsWithBreak: Bool) {
        self.lines = lines
        self.endsWithBreak = endsWithBreak
    }
}
