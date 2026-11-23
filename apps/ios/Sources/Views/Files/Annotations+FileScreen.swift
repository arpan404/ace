import SwiftUI

/// Notes on code from a thread's file, as the web's editor annotates: select lines, then
/// Annotate (while editing) or Comment (while reading), and say what the agent should do. The
/// note waits on the thread's next message (`ClientModel.codeNotes`), shown by a dot in the
/// gutter and a capsule over the text, and follows its lines through typing, an agent's rewrite
/// and a rename, in whichever editor group shows the file.
extension FileScreen {
    /// The thread whose next message takes notes from this file; nil for a project's files or a
    /// pairing that can't send.
    var noteThread: String? {
        guard model.canOperate, case .thread(let id) = scope else { return nil }
        return id
    }

    var notesHere: [FileNotesChip.Numbered] {
        guard let thread = noteThread else { return [] }
        return model.codeNotes[thread].enumerated().compactMap { index, note in
            note.path == path ? FileNotesChip.Numbered(number: index + 1, note: note) : nil
        }
    }

    /// The line each note starts on, with its number, for the gutter.
    var noteMarks: [Int: Int] {
        var marks: [Int: Int] = [:]
        for entry in notesHere where marks[entry.note.span.start.line + 1] == nil {
            marks[entry.note.span.start.line + 1] = entry.number
        }
        return marks
    }

    /// Typing moves this file's notes; nil while it has none, so typing costs nothing more.
    var noteEdited: ((TextReplacement, (Int) -> String) -> Void)? {
        guard let thread = noteThread, !notesHere.isEmpty else { return nil }
        let (model, path) = (model, path)
        return { replacement, line in model.codeEdited(thread, path: path, through: [replacement], line: line) }
    }

    /// Other text over the file (an agent's change, a discarded edit): its notes find their code.
    var noteLoaded: (@MainActor ([String]?, [String]) -> Void)? {
        guard let thread = noteThread else { return nil }
        let (model, path) = (model, path)
        return { before, after in model.codeReloaded(thread, path: path, before: before, after: after) }
    }

    func annotate(_ span: TextSpan) {
        let lines = AnnotationAnchor.lines(handle.text)
        let excerpt = AnnotationAnchor.excerpt(AnnotationAnchor.text(of: span, in: lines)).text
        guard !excerpt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        noting = NoteDraft(id: UUID().uuidString, span: span, existing: nil, comment: "", excerpt: excerpt, lines: lines, path: path)
    }

    func editNote(_ note: CodeNote) {
        noting = NoteDraft(id: note.id, span: note.span, existing: note.id, comment: note.comment, excerpt: note.excerpt)
    }

    func noteSheet(_ draft: NoteDraft) -> some View {
        let number = draft.existing.flatMap { id in notesHere.first { $0.note.id == id }?.number }
        let title = number.map { "Note \($0)" } ?? (editing ? "Annotate" : "Comment")
        let place = CodeNoteChips.place(CodeNote(id: draft.id, path: path, span: draft.span, excerpt: draft.excerpt, cut: false, comment: ""))
        return AnnotationsSheet(draft: draft, title: title, place: place) { comment in
            guard let thread = noteThread else { return CodeNoteRefusal.cantAct.message }
            if let id = draft.existing {
                return model.commentCodeNote(thread, id: id, comment)?.message
            }
            // The file may have reloaded while the sheet was open (an agent's change): the
            // range is found again in the text shown now, or the note joins outdated.
            let now = draft.path == path ? AnnotationAnchor.lines(handle.text) : nil
            if case .failure(let refusal) = model.addCodeNote(thread, path: draft.path, span: draft.span, lines: draft.lines, now: now, comment: comment) {
                return refusal.message
            }
            return nil
        }
    }

    /// The file's notes over the text, out of the way of the selection's Mention capsule.
    @ViewBuilder var notesChip: some View {
        let notes = notesHere
        if !notes.isEmpty, selectedLines == nil, showsSource {
            FileNotesChip(
                notes: notes,
                go: { handle.go(to: GoToLine.Target(line: $0.span.start.line + 1, column: $0.span.start.column + 1)) },
                edit: { editNote($0) },
                remove: { note in if let thread = noteThread { model.removeCodeNote(thread, id: note.id) } },
                handOff: handOffNotes
            )
            .padding(.trailing, AceDesign.Space.margin)
            .padding(.bottom, AceTheme.Spacing.lg)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        }
    }
}
