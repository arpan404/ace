import Foundation

/// The pages of one log a view has read, and which read each page may still take. A log is read
/// a page at a time near the screen; a live log (a check still running) reads its tail again as
/// it grows. Each read gets a ticket: an answer for an older ticket of the same page, or for a
/// log the view no longer shows, is dropped, so a slow early read never overwrites a newer one.
struct ForgeLogPaging: Equatable {
    static let pageSize = 200

    /// Which log the pages belong to; a new identity starts over.
    private(set) var identity: String
    private(set) var pages: [Int: [String]] = [:]
    /// Lines in the log as last read; nil before any read says.
    private(set) var count: Int?
    /// The newest ticket asked for each page that hasn't answered yet.
    private var waiting: [Int: Int] = [:]
    private var tickets = 0

    struct Ticket: Equatable, Sendable { let identity: String; let page: Int; let number: Int }

    init(identity: String, total: Int? = nil) {
        self.identity = identity
        self.count = total
    }

    /// Lines to draw: the read count, else what the opener knew.
    var lines: Int { count ?? 0 }

    /// Starts over on another log; the same one keeps what it has.
    mutating func show(_ identity: String, total: Int?) {
        if identity != self.identity { self = ForgeLogPaging(identity: identity, total: total) }
        else if let total, count == nil || total > (count ?? 0) { count = total }
    }

    /// The pages to read for a line coming on screen: its page, and the next near its end.
    /// Pages already read or being read are left alone.
    mutating func near(_ index: Int) -> [Ticket] {
        let page = index / Self.pageSize
        var wanted = [page]
        if index % Self.pageSize > Self.pageSize - 40 { wanted.append(page + 1) }
        return wanted.compactMap { wanted in
            guard pages[wanted] == nil, waiting[wanted] == nil, inside(wanted) else { return nil }
            return ticket(wanted)
        }
    }

    /// A live log's tail read again: the last page read and the one after it, even when read
    /// before, since a running check keeps writing. Nothing while those reads are still out.
    mutating func tail() -> [Ticket] {
        let last = max(0, (lines - 1) / Self.pageSize)
        return [last, last + 1].compactMap { page in
            guard waiting[page] == nil, page == last || pages[last] != nil else { return nil }
            return ticket(page)
        }
    }

    /// Takes an answer if it is still the newest asked for its page of this log.
    @discardableResult
    mutating func accept(_ ticket: Ticket, lines read: [String], total: Int) -> Bool {
        guard ticket.identity == identity, waiting[ticket.page] == ticket.number else { return false }
        waiting[ticket.page] = nil
        if !read.isEmpty || ticket.page == 0 { pages[ticket.page] = read }
        count = total
        // Pages past the end of a log that shrank (a run started over) are let go.
        for page in pages.keys where page * Self.pageSize >= max(total, 1) && page > 0 { pages[page] = nil }
        return true
    }

    /// A read that failed may be asked again.
    mutating func failed(_ ticket: Ticket) {
        if waiting[ticket.page] == ticket.number { waiting[ticket.page] = nil }
    }

    /// The text of a line once its page is read.
    func line(_ index: Int) -> String? {
        pages[index / Self.pageSize].flatMap { page in
            index % Self.pageSize < page.count ? page[index % Self.pageSize] : nil
        }
    }

    func loaded(_ index: Int) -> Bool { pages[index / Self.pageSize] != nil }

    private func inside(_ page: Int) -> Bool { count.map { page * Self.pageSize < max($0, 1) } ?? true }

    private mutating func ticket(_ page: Int) -> Ticket {
        tickets += 1
        waiting[page] = tickets
        return Ticket(identity: identity, page: page, number: tickets)
    }
}
