import Foundation

/// Find in a file too large to hold, searched a page at a time in order: each page is searched
/// once as it comes and then let go, so a search costs one page of text and a bounded batch of
/// matches however long the file is. A batch holds at most `limit` matches; once it is full the
/// search stops there and remembers where, so matches past any count stay reachable: Next past
/// the batch lets it go and searches on from that point. Pure.
struct FileSearch: Equatable {
    /// One match: its line (0-based, in the file), where in the line (in characters), and the
    /// page it is on with that page's first line, so the view can read that page to show it.
    struct Hit: Equatable {
        let page: Int
        let pageLine: Int
        let line: Int
        let column: Int
    }
    /// Where the search goes on: a page, its first line, and the last match already taken in it.
    struct Resume: Equatable {
        let page: Int
        let firstLine: Int
        var after: (line: Int, column: Int)?
        static func == (lhs: Resume, rhs: Resume) -> Bool {
            lhs.page == rhs.page && lhs.firstLine == rhs.firstLine && lhs.after?.line == rhs.after?.line && lhs.after?.column == rhs.after?.column
        }
    }

    let query: String
    let limit: Int
    /// The batch held, and the overall index of its first match.
    private(set) var hits: [Hit] = []
    private(set) var base = 0
    /// Where searching goes on; nil once the file is searched to its end.
    private(set) var next: Resume? = Resume(page: 0, firstLine: 0, after: nil)

    init(query: String, limit: Int = 10_000) {
        self.query = query
        self.limit = limit
    }

    /// Every match is found and held: the count is final.
    var complete: Bool { next == nil }
    /// The batch is full and more of the file is left to search.
    var full: Bool { hits.count >= limit && next != nil }
    /// Matches found so far, overall.
    var found: Int { base + hits.count }
    /// The match at an overall index, when the batch holds it.
    func hit(_ index: Int) -> Hit? { hits.indices.contains(index - base) ? hits[index - base] : nil }

    /// Search the page the search is waiting on (any other page is ignored).
    mutating func take(_ page: FilePageAnswer) {
        guard !query.isEmpty, let resume = next, page.offset == resume.page, !full else { return }
        let lines = PageLines(page.text).lines
        for (index, text) in lines.enumerated() {
            let line = resume.firstLine + index
            var from = text.startIndex
            while let range = text.range(of: query, options: [.caseInsensitive], range: from..<text.endIndex) {
                let column = text.distance(from: text.startIndex, to: range.lowerBound)
                from = range.upperBound
                if let after = resume.after, (line, column) <= (after.line, after.column) { continue }
                if hits.count >= limit {
                    // Full: go on later from the last match taken.
                    next = Resume(page: page.offset, firstLine: resume.firstLine, after: hits.last.map { ($0.line, $0.column) })
                    return
                }
                hits.append(Hit(page: page.offset, pageLine: resume.firstLine, line: line, column: column))
            }
        }
        next = page.done ? nil : Resume(page: page.nextOffset, firstLine: resume.firstLine + lines.count, after: nil)
    }

    /// Let the full batch go so the search can go on past it.
    mutating func advance() {
        base += hits.count
        hits = []
    }

    /// Search again from the file's start (Previous before the batch held, or wrapping round).
    mutating func rewind() {
        hits = []
        base = 0
        next = Resume(page: 0, firstLine: 0, after: nil)
    }
}

/// What Next or Previous does from the current match (an overall index) given the search so far.
enum FindStep: Equatable {
    /// Show this overall index; the batch holds it.
    case show(Int)
    /// Search on (reading the next page), after letting a full batch go when `advance`.
    case search(advance: Bool)
    /// Search again from the start, until the batch holds this overall index.
    case rewind(to: Int)
    case none

    static func next(from current: Int?, in search: FileSearch) -> FindStep {
        let wanted = current.map { $0 + 1 } ?? 0
        if search.hit(wanted) != nil { return .show(wanted) }
        if wanted < search.found { return .rewind(to: wanted) }
        if !search.complete { return .search(advance: search.full) }
        // Searched to the end: round to the first match.
        guard search.found > 0 else { return .none }
        return search.hit(0) != nil ? .show(0) : .rewind(to: 0)
    }

    static func previous(from current: Int?, in search: FileSearch) -> FindStep {
        guard let current, current > 0 else {
            // Before the first: the last match, once the count is final.
            guard search.complete, search.found > 0 else { return .none }
            return search.hit(search.found - 1) != nil ? .show(search.found - 1) : .rewind(to: search.found - 1)
        }
        return search.hit(current - 1) != nil ? .show(current - 1) : .rewind(to: current - 1)
    }
}
