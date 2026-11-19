import Foundation

/// Find in a file too large to hold, searched a page at a time in order: each page is searched
/// once as it comes and then let go, so a search costs one page of text and a bounded batch of
/// matches however long the file is. A line longer than a page is cut between pages; the end of
/// the cut line (one character short of the query) carries into the next page, so a match
/// across the cut is found, and line numbers carry on through it. A batch holds at most `limit`
/// matches; once it is full the search stops at the match that didn't fit and remembers where,
/// so matches past any count stay reachable and no page is searched twice. Work is linear in
/// the text searched. Pure.
struct LargeFileFind: Equatable {
    /// One match: its line (0-based, in the file), where in the line (in characters), and the
    /// page it starts on with the line that page starts in, so the view can show that page.
    struct Hit: Equatable {
        let page: Int
        let pageLine: Int
        let line: Int
        let column: Int
    }
    /// The end of a page's last line when the page ends inside it, and where that end is.
    struct Carry: Equatable {
        let text: String
        let page: Int
        let pageLine: Int
        let line: Int
        let column: Int
    }
    /// Where the search goes on.
    struct Resume: Equatable {
        let page: Int
        /// The line the page starts in (a cut line goes on into the next page).
        let firstLine: Int
        /// The UTF-16 offset in the page's text to go on from, and the line and column there.
        var position = 0
        var line: Int
        var column: Int
        /// The previous page's cut line end, searched before this page's text.
        var carry: Carry?
    }

    let query: String
    let limit: Int
    /// The batch held, and the overall index of its first match.
    private(set) var hits: [Hit] = []
    private(set) var base = 0
    /// Where searching goes on; nil once the file is searched to its end.
    private(set) var next: Resume? = Resume(page: 0, firstLine: 0, line: 0, column: 0)

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

    /// Search the page the search is waiting on (any other page is ignored), from where it left off.
    mutating func take(_ page: FilePageAnswer) {
        guard !query.isEmpty, let resume = next, page.offset == resume.page, !full else { return }
        let text = page.text
        let start = String.Index(utf16Offset: min(resume.position, text.utf16.count), in: text)
        let carry = resume.position == 0 ? resume.carry : nil
        let prefix = carry?.text ?? ""
        let searched = prefix + text[start...]
        let prefixEnd = String.Index(utf16Offset: prefix.utf16.count, in: searched)
        var cursor = searched.startIndex
        var line = carry?.line ?? resume.line
        var column = carry?.column ?? resume.column
        var from = searched.startIndex
        var lastEnd = searched.startIndex
        while let range = searched.range(of: query, options: [.caseInsensitive], range: from..<searched.endIndex) {
            walk(searched[cursor..<range.lowerBound], line: &line, column: &column)
            cursor = range.lowerBound
            let inCarry = range.lowerBound < prefixEnd
            if hits.count >= limit {
                // Full: the next batch starts at this match.
                next = inCarry
                    ? resume
                    : Resume(page: page.offset, firstLine: resume.firstLine,
                             position: resume.position + searched.utf16.distance(from: prefixEnd, to: range.lowerBound),
                             line: line, column: column)
                return
            }
            hits.append(Hit(page: inCarry ? carry?.page ?? page.offset : page.offset,
                            pageLine: inCarry ? carry?.pageLine ?? resume.firstLine : resume.firstLine,
                            line: line, column: column))
            from = range.upperBound
            lastEnd = range.upperBound
        }
        walk(searched[cursor...], line: &line, column: &column)
        guard !page.done else { next = nil; return }
        next = Resume(page: page.nextOffset, firstLine: line, line: line, column: column,
                      carry: Self.carry(of: searched, after: max(lastEnd, prefixEnd), length: query.count - 1,
                                        page: page.offset, pageLine: resume.firstLine, line: line, column: column))
    }

    /// The end of the searched text's last line, at most `length` characters, none before `after`
    /// (a match already taken, or the previous page's carry); nil when the text ends a line.
    private static func carry(of searched: String, after: String.Index, length: Int,
                              page: Int, pageLine: Int, line: Int, column: Int) -> Carry? {
        guard length > 0, searched.unicodeScalars.last != "\n" else { return nil }
        var start = searched.endIndex
        var count = 0
        while count < length, start > after {
            let previous = searched.index(before: start)
            if searched[previous].unicodeScalars.contains("\n") { break }
            start = previous
            count += 1
        }
        guard count > 0 else { return nil }
        return Carry(text: String(searched[start...]), page: page, pageLine: pageLine, line: line, column: column - count)
    }

    /// Count lines and columns over `text`: a line feed (CRLF too) starts a line.
    private mutating func walk(_ text: Substring, line: inout Int, column: inout Int) {
        for character in text {
            if character.unicodeScalars.contains("\n") { line += 1; column = 0 } else { column += 1 }
        }
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
        next = Resume(page: 0, firstLine: 0, line: 0, column: 0)
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

    static func next(from current: Int?, in search: LargeFileFind) -> FindStep {
        let wanted = current.map { $0 + 1 } ?? 0
        if search.hit(wanted) != nil { return .show(wanted) }
        if wanted < search.found { return .rewind(to: wanted) }
        if !search.complete { return .search(advance: search.full) }
        // Searched to the end: round to the first match.
        guard search.found > 0 else { return .none }
        return search.hit(0) != nil ? .show(0) : .rewind(to: 0)
    }

    static func previous(from current: Int?, in search: LargeFileFind) -> FindStep {
        guard let current, current > 0 else {
            // Before the first: the last match, once the count is final.
            guard search.complete, search.found > 0 else { return .none }
            return search.hit(search.found - 1) != nil ? .show(search.found - 1) : .rewind(to: search.found - 1)
        }
        return search.hit(current - 1) != nil ? .show(current - 1) : .rewind(to: current - 1)
    }
}
