import Foundation

/// One file's edit in the iPad editor, kept apart from the view showing it.
struct EditorDraft: Equatable, Sendable {
    /// The exact machine snapshot the edit began from, even if the tab moves.
    var base: FileContent
    /// The text typed so far, once the editor that held it went away; nil while it is on screen.
    var text: String?
    var dirty: Bool
}

/// The editor's drafts, by file. An editor can go at any time (its tab moved or another took its
/// place, compact width hid its group), so a file being edited keeps its draft here and the
/// next editor showing the file picks it up. Only saving or discarding ends a draft with changes.
struct EditorDrafts: Equatable, Sendable {
    private var drafts: [String: EditorDraft] = [:]

    subscript(path: String) -> EditorDraft? { drafts[path] }

    /// Some file is being edited: the editor can't be left until it is saved or discarded.
    var editing: Bool { !drafts.isEmpty }

    /// Files with unsaved changes: closing one asks first, and one closed elsewhere keeps its tab.
    var unsaved: Set<String> { Set(drafts.filter(\.value.dirty).keys) }

    /// Editing began, or the editor came back to a file already being edited (whose base stays).
    mutating func begin(_ path: String, base: FileContent) {
        if drafts[path] == nil { drafts[path] = EditorDraft(base: base, text: nil, dirty: false) }
    }

    /// The text now differs from the file (or no longer does). An editor that came back to a
    /// file whose clean draft was dropped meanwhile starts it again from `base`.
    mutating func mark(_ path: String, dirty: Bool, base: FileContent) {
        if drafts[path] == nil {
            if dirty { drafts[path] = EditorDraft(base: base, text: nil, dirty: true) }
        } else {
            drafts[path]?.dirty = dirty
        }
    }

    /// The editor showing `path` went away with `text` in it: kept when it changed the file.
    mutating func left(_ path: String, text: String) {
        guard let draft = drafts[path] else { return }
        if draft.dirty { drafts[path]?.text = text } else { drafts[path] = nil }
    }

    /// A merge or a save moved the base to a known version on the machine.
    mutating func rebase(_ path: String, onto base: FileContent, text: String) {
        drafts[path] = EditorDraft(base: base, text: text, dirty: !text.utf8.elementsEqual((base.text ?? "").utf8))
    }

    /// Saved, or the changes discarded.
    mutating func end(_ path: String) { drafts[path] = nil }

    mutating func rename(_ path: String, to destination: String) {
        guard let draft = drafts.removeValue(forKey: path) else { return }
        drafts[destination] = draft
    }

    /// Which of `paths` can close at once, and which hold changes the person must discard first.
    func closing(_ paths: [String]) -> (now: [String], ask: [String]) {
        (paths.filter { drafts[$0]?.dirty != true }, paths.filter { drafts[$0]?.dirty == true })
    }

    /// A tab closed: a draft without changes goes with it.
    mutating func closed(_ path: String) {
        if drafts[path]?.dirty != true { drafts[path] = nil }
    }
}
