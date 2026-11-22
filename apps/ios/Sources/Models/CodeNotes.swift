import Foundation

/// A note pinned to a range of a file in the editor, waiting for the thread's next message.
struct CodeNote: Equatable, Sendable, Identifiable {
    let id: String
    var path: String
    var span: TextSpan
    /// The range's text as it was marked, or as an edit to it left it: the code the agent reads.
    var excerpt: String
    var cut: Bool
    var comment: String
    /// The code it pointed at changed or was deleted since it was made.
    var outdated = false
    /// The checkout it was made in (machine and checkout root), so a rename in that checkout
    /// moves it and one in another checkout never does; nil when the root wasn't known yet.
    var checkout: String? = nil
    /// 1-based, inclusive: "12" or "12–18", a range ending at a line's start stopping before it.
    var lines: ClosedRange<Int> {
        let last = span.end.column == 0 && span.end.line > span.start.line ? span.end.line : span.end.line + 1
        return (span.start.line + 1)...max(span.start.line + 1, last)
    }
}

/// Each thread's code notes, as the web's composer draft keeps them (`code-drafts.ts`): numbered
/// 1…n in the order they were made, closing ranks when one leaves. The editor owns them, so a
/// note moves with every keystroke at once and outlasts its file's editor going (a tab moved,
/// a group hid) and a visit to the thread; the open thread's bridge session gets the whole list
/// (`wire`) and says which notes a sent message took (`sent`). Pure.
struct CodeNotes: Equatable, Sendable {
    /// At most this many in one message (`codeAnnotationLimit` in `@ace/ui-core`).
    static let limit = 20
    private var threads: [String: [CodeNote]] = [:]

    subscript(thread: String) -> [CodeNote] { threads[thread] ?? [] }
    func full(_ thread: String) -> Bool { self[thread].count >= Self.limit }
    /// The notes on one file of a thread.
    func on(_ thread: String, path: String) -> [CodeNote] { self[thread].filter { $0.path == path } }
    /// A note's number: its place in the thread's list.
    func number(_ thread: String, id: String) -> Int? { self[thread].firstIndex { $0.id == id }.map { $0 + 1 } }

    /// A new note on `span` of `path`, made over `lines`; nothing once the thread is full. When
    /// the file's text is `now` by the time it is added (it reloaded while the note was written),
    /// the range is found again in it, or the note joins outdated with the code it was on.
    mutating func add(_ thread: String, path: String, span: TextSpan, lines: [String], now: [String]? = nil,
                      comment: String, id: String, checkout: String? = nil) {
        guard !full(thread) else { return }
        let excerpt = AnnotationAnchor.excerpt(AnnotationAnchor.text(of: span, in: lines))
        var note = CodeNote(id: id, path: path, span: span, excerpt: excerpt.text, cut: excerpt.cut, comment: comment, checkout: checkout)
        if let now, !AnnotationAnchor.same(lines, now) {
            let anchored = AnnotationAnchor.reanchor(span, excerpt: excerpt.text, cut: excerpt.cut, before: lines, after: now)
            note.span = anchored.span
            note.outdated = anchored.outdated
        }
        threads[thread, default: []].append(note)
    }

    mutating func comment(_ thread: String, id: String, _ comment: String) {
        update(thread) { if $0.id == id { $0.comment = comment } }
    }

    mutating func remove(_ thread: String, id: String) {
        threads[thread]?.removeAll { $0.id == id }
        if threads[thread]?.isEmpty == true { threads[thread] = nil }
    }

    mutating func clear(_ thread: String) { threads[thread] = nil }

    /// A message took these notes; any made since stay.
    mutating func sent(_ thread: String, ids: [String]) {
        let gone = Set(ids)
        threads[thread]?.removeAll { gone.contains($0.id) }
        if threads[thread]?.isEmpty == true { threads[thread] = nil }
    }

    /// The person typed in `path`: its notes move with the edit, and one the edit touched keeps
    /// the text it holds now (`lines`, the text after the edit).
    mutating func edited(_ thread: String, path: String, through replacements: [TextReplacement], lines: [String]) {
        edited(thread, path: path, through: replacements) { $0 < lines.count ? lines[$0] : "" }
    }
    /// As above, reading only the lines a touched note holds (`line`, 0-based, after the edit).
    mutating func edited(_ thread: String, path: String, through replacements: [TextReplacement], line: (Int) -> String) {
        update(thread) { note in
            guard note.path == path else { return }
            let moved = AnnotationAnchor.map(note.span, through: replacements)
            let touched = AnnotationAnchor.touches(note.span, replacements)
            note.span = moved.span
            if moved.outdated { note.outdated = true }
            // An outdated note keeps the code it was on: typing where it was isn't that code.
            if touched, !moved.outdated, !note.outdated {
                let excerpt = AnnotationAnchor.excerpt(AnnotationAnchor.text(of: moved.span, line: line))
                note.excerpt = excerpt.text
                note.cut = excerpt.cut
            }
        }
    }

    /// `path`'s whole text changed (an agent rewrote it, or an edit was discarded), from `before`
    /// when the editor had it, to `after`: each note is found again on its code or marked outdated.
    mutating func reloaded(_ thread: String, path: String, before: [String]?, after: [String]) {
        update(thread) { note in
            guard note.path == path, !note.outdated else { return }
            let anchored = before.map {
                AnnotationAnchor.reanchor(note.span, excerpt: note.excerpt, cut: note.cut, before: $0, after: after)
            } ?? AnnotationAnchor.verify(note.span, excerpt: note.excerpt, cut: note.cut, lines: after)
            note.span = anchored.span
            note.outdated = anchored.outdated
        }
    }

    /// A file or folder (ending in "/") moved or was renamed in `checkout` from `thread`: the
    /// notes made in that checkout follow it, in every thread sharing it, and so do the renaming
    /// thread's own notes made before its root was known. Another checkout's notes never move.
    mutating func renamed(in checkout: String?, thread renaming: String, from path: String, to destination: String) {
        let folder = path.hasSuffix("/")
        let into = folder && !destination.hasSuffix("/") ? destination + "/" : destination
        for thread in threads.keys {
            update(thread) { note in
                let here = note.checkout.map { $0 == checkout } ?? (thread == renaming)
                guard here else { return }
                if note.path == path { note.path = destination }
                else if folder, note.path.hasPrefix(path) { note.path = into + note.path.dropFirst(path.count) }
            }
        }
    }

    /// The thread's notes as `CodeAnnotation` records (`@ace/ui-core`), numbered 1…n.
    func wire(_ thread: String) -> [[String: Any]] {
        self[thread].enumerated().map { index, note in
            var record: [String: Any] = [
                "id": note.id, "number": index + 1, "path": note.path,
                "start": ["line": note.span.start.line, "column": note.span.start.column],
                "end": ["line": note.span.end.line, "column": note.span.end.column],
                "excerpt": note.excerpt, "comment": note.comment,
            ]
            if note.cut { record["cut"] = true }
            if note.outdated { record["outdated"] = true }
            return record
        }
    }

    private mutating func update(_ thread: String, _ change: (inout CodeNote) -> Void) {
        guard var list = threads[thread] else { return }
        for index in list.indices { change(&list[index]) }
        if list != threads[thread] { threads[thread] = list }
    }
}
