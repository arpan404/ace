import Foundation

/// Notes made from a diff (a pull request's file, Changes) rather than the editor. A diff shows
/// only some of a file's lines, so a note there takes whole lines of the new side. A diff read
/// again keeps a note whose code is still on its lines, and otherwise looks for the code on every
/// line it shows: found once, the note moves there. Not found, a note whose lines are all shown is
/// outdated (its code is gone); one whose lines aren't is unverified, as its code may sit on lines
/// the diff leaves out. The editor checks it against the whole file when it opens (`reloaded`).
/// Pure.
extension CodeNotes {
    /// The range of whole lines `first`…`first + texts.count - 1` (1-based), whose texts are `texts`.
    static func span(first: Int, texts: [String]) -> TextSpan {
        let last = first + max(texts.count, 1) - 1
        let length = ((texts.last ?? "") as NSString).length
        return TextSpan(start: TextPlace(line: first - 1, column: 0), end: TextPlace(line: last - 1, column: length))
    }

    /// A new note on the new side's lines from `first` (1-based), whose texts are `texts`, in a
    /// diff of `path`; nothing once the thread is full or the lines hold no code.
    mutating func add(_ thread: String, path: String, first: Int, texts: [String], comment: String, id: String, checkout: String? = nil) {
        guard first > 0, !texts.isEmpty, !texts.joined().trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let excerpt = AnnotationAnchor.excerpt(texts.joined(separator: "\n"))
        append(thread, CodeNote(id: id, path: path, span: Self.span(first: first, texts: texts), excerpt: excerpt.text,
                                cut: excerpt.cut, comment: comment, checkout: checkout))
    }

    /// `path`'s diff was read again and shows `lines` of the new side (1-based number to whole
    /// text; clipped lines left out).
    mutating func shown(_ thread: String, path: String, lines: [Int: String]) {
        guard !lines.isEmpty, self[thread].contains(where: { $0.path == path && !$0.outdated }) else { return }
        let runs = Self.runs(lines)
        update(thread) { note in
            guard note.path == path, !note.outdated else { return }
            let shownWhole = note.lines.allSatisfy { lines[$0] != nil }
            if shownWhole {
                let here = AnnotationAnchor.text(of: note.span) { lines[$0 + 1] ?? "" }
                let holds = note.cut ? here.utf16.starts(with: note.excerpt.utf16) : AnnotationAnchor.same(here, note.excerpt)
                if holds { note.unverified = false; return }
            }
            if !note.cut, let found = Self.findOnce(note.excerpt, in: runs) {
                note.span = found
                note.unverified = false
            } else if shownWhole {
                note.outdated = true
            } else {
                note.unverified = true
            }
        }
    }

    /// Shown lines in runs without gaps: each run's first line (0-based) and its text.
    private static func runs(_ lines: [Int: String]) -> [(first: Int, text: String)] {
        var runs: [(first: Int, text: String)] = []
        var current: (first: Int, lines: [String])?
        var previous = Int.min
        for number in lines.keys.sorted() {
            let text = lines[number] ?? ""
            if var run = current, number == previous + 1 {
                run.lines.append(text)
                current = run
            } else {
                if let run = current { runs.append((run.first, run.lines.joined(separator: "\n"))) }
                current = (number - 1, [text])
            }
            previous = number
        }
        if let run = current { runs.append((run.first, run.lines.joined(separator: "\n"))) }
        return runs
    }

    /// The one place among the runs `excerpt` stands; nil when it is in none, or more than once.
    private static func findOnce(_ excerpt: String, in runs: [(first: Int, text: String)]) -> TextSpan? {
        var found: TextSpan?
        for run in runs where run.text.utf16.count >= excerpt.utf16.count {
            let text = run.text as NSString
            guard text.range(of: excerpt, options: .literal).location != NSNotFound else { continue }
            guard found == nil, let span = AnnotationAnchor.findOnce(run.text, excerpt) else { return nil }
            found = TextSpan(start: TextPlace(line: span.start.line + run.first, column: span.start.column),
                             end: TextPlace(line: span.end.line + run.first, column: span.end.column))
        }
        return found
    }
}
