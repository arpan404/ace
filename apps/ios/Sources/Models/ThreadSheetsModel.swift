import Foundation
import Observation

/// The open thread's Agents and Changes sheets. The bridge follows each only while it is shown;
/// rows arrive shaped, and git outcomes are correlated by request id.
@MainActor @Observable final class ThreadSheetsModel {
    var agents: AgentSheet?
    var changes: ChangesSummary?
    /// The listed files as folders and files (`changes:tree`).
    var tree: [ChangesTreeRow] = []
    /// Open files by path, and their pages by file id (only pages of the header's version).
    var files: [String: ChangesFileHeader] = [:]
    var pages: [String: [Int: ChangesPage]] = [:]
    /// Rows read whole after Show whole line, by file id and row index.
    var wholeLines: [String: [Int: ChangesRow]] = [:]
    var review: ChangesReview?
    var replies: ChangesReplies?
    var notices: [String: ChangesNotice] = [:]
    var outcomes: [String: GitOutcome] = [:]
    /// The latest AI draft for the commit or PR editor.
    var draft: GitDraft?

    func reset() {
        agents = nil; changes = nil; tree = []; files = [:]; pages = [:]; wholeLines = [:]
        review = nil; replies = nil; notices = [:]; outcomes = [:]; draft = nil
    }

    func apply(_ summary: ChangesSummary) {
        changes = summary
        // The bridge never sends a close: a file no longer open goes with its pages.
        let open = Set(summary.open ?? [])
        for (path, header) in files where !open.contains(path) {
            files[path] = nil
            pages[header.file] = nil
            wholeLines[header.file] = nil
        }
    }

    func apply(_ patch: ChangesPatch) {
        switch patch {
        case .tree(let rows): tree = rows
        case .file(let header):
            if let old = files[header.path], old.version != header.version || old.file != header.file {
                pages[old.file] = nil
                wholeLines[old.file] = nil
            }
            files[header.path] = header
        case .page(let page):
            guard files[page.path]?.version == page.version else { return }
            pages[page.file, default: [:]][page.index] = page
        case .line(let line):
            guard files[line.path]?.version == line.version else { return }
            wholeLines[line.file, default: [:]][line.row.i] = line.row
        case .review(let review): self.review = review
        case .replies(let replies): self.replies = replies
        case .notice(let notice): notices[notice.requestId] = notice
        }
    }

    /// An open file's rows in order, as far as its pages have come.
    func rows(_ file: ChangesFileHeader) -> [ChangesRow] {
        let held = pages[file.file] ?? [:]
        var out: [ChangesRow] = []
        var index = 0
        while let page = held[index] {
            out += page.lines ?? (page.pairs ?? []).flatMap { pair in [pair.fold, pair.left, pair.right].compactMap { $0 } }
            index += 1
        }
        let whole = wholeLines[file.file] ?? [:]
        return whole.isEmpty ? out : out.map { whole[$0.i] ?? $0 }
    }

    /// An open file's split pairs in order (when the layout is split).
    func pairs(_ file: ChangesFileHeader) -> [ChangesPair] {
        let held = pages[file.file] ?? [:]
        var out: [ChangesPair] = []
        var index = 0
        while let page = held[index] {
            out += page.pairs ?? []
            index += 1
        }
        return out
    }
}
