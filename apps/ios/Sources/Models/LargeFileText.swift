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

/// What has been read of a large file, as the parts its pages came in. Each part keeps the bytes
/// it covers, so it can be edited on its own and saved over exactly those bytes, and find runs
/// over the lines read so far. Pure.
struct LargeFileText: Equatable {
    struct Part: Identifiable, Equatable {
        /// The bytes of the file the part covers: `[offset, end)`.
        let offset: Int
        let end: Int
        /// The 0-based line number of its first line in the file.
        let firstLine: Int
        let lines: [String]
        /// The part's text ended with a line break (every part but a file's last one does).
        let endsWithBreak: Bool
        var id: Int { offset }
        var length: Int { end - offset }
        /// The part's text exactly as read, for editing it.
        var text: String { lines.joined(separator: "\n") + (endsWithBreak ? "\n" : "") }
    }
    /// One place `query` was found: a line (0-based, in the file) and where in it, in characters.
    struct Match: Equatable {
        let line: Int
        let column: Int
    }

    private(set) var parts: [Part] = []
    private(set) var version: String?
    private(set) var size = 0
    private(set) var done = false
    /// Where the next page starts.
    private(set) var next = 0
    var lineCount: Int { parts.last.map { $0.firstLine + $0.lines.count } ?? 0 }

    /// Add the next page read.
    mutating func take(_ page: FilePageAnswer) {
        guard page.offset == next else { return }
        var text = Substring(page.text)
        let endsWithBreak = text.hasSuffix("\n")
        if endsWithBreak { text = text.dropLast() }
        let lines = page.text.isEmpty ? [] : text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        parts.append(Part(offset: page.offset, end: page.nextOffset, firstLine: lineCount, lines: lines, endsWithBreak: endsWithBreak))
        version = page.version
        size = page.size
        next = page.nextOffset
        done = page.done
    }

    /// The share read so far, 0–99 until the end is reached.
    var percent: Int { done ? 100 : size > 0 ? min(99, next * 100 / size) : 0 }

    /// Every place `query` is in the lines read so far, any case, in order; at most `limit`.
    func matches(_ query: String, limit: Int = 10_000) -> [Match] {
        guard !query.isEmpty else { return [] }
        var found: [Match] = []
        for part in parts {
            for (index, line) in part.lines.enumerated() {
                var from = line.startIndex
                while found.count < limit, let range = line.range(of: query, options: [.caseInsensitive], range: from..<line.endIndex) {
                    found.append(Match(line: part.firstLine + index, column: line.distance(from: line.startIndex, to: range.lowerBound)))
                    from = range.upperBound
                }
                if found.count >= limit { return found }
            }
        }
        return found
    }
}

/// Stepping through find's matches: Next past the last one reads on while the file has more,
/// and only wraps to the first once the whole file has been searched.
enum FindStep: Equatable {
    case show(Int)
    case readMore
    case none

    static func next(from index: Int?, count: Int, done: Bool) -> FindStep {
        guard let index else { return count > 0 ? .show(0) : done ? .none : .readMore }
        if index + 1 < count { return .show(index + 1) }
        return done ? (count > 0 ? .show(0) : .none) : .readMore
    }

    static func previous(from index: Int?, count: Int) -> FindStep {
        guard count > 0 else { return .none }
        guard let index, index > 0 else { return .show(count - 1) }
        return .show(index - 1)
    }
}
