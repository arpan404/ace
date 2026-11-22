import SwiftUI

extension EnvironmentValues {
    /// Back to the thread's composer, where the editor's code notes wait on the next message; nil
    /// where no composer can take them (the person can't send, or no thread opened the editor).
    @Entry var codeNotesHandOff: (() -> Void)? = nil
}

/// A note being written on a range of the open file: a new one from the selection, or one
/// already on the next message whose words change.
struct NoteDraft: Identifiable {
    let id: String
    let span: TextSpan
    /// The note this changes; nil for a new one.
    let existing: String?
    let comment: String
    /// The code it is on, as the sheet shows it.
    let excerpt: String
    /// The file's lines when the note was made, for its excerpt; empty for an existing note.
    var lines: [String] = []
    /// The file it was made on: a sheet left open while another file took the view keeps it.
    var path = ""
}

/// Annotate (editing) or Comment (reading): what the person wants done with the selected code,
/// the code itself quoted above the field. Save puts the note on the thread's next message.
struct AnnotationsSheet: View {
    let draft: NoteDraft
    /// "Annotate", "Comment" or "Note 2".
    let title: String
    /// "total.ts:2–3".
    let place: String
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var comment: String
    @FocusState private var focused: Bool

    init(draft: NoteDraft, title: String, place: String, save: @escaping (String) -> Void) {
        self.draft = draft
        self.title = title
        self.place = place
        self.save = save
        _comment = State(initialValue: draft.comment)
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: AceDesign.Space.row) {
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text(place)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .monospacedDigit()
                    Text(draft.excerpt)
                        .aceMonospace(AceDesign.TextRole.code)
                        .foregroundStyle(AceDesign.Ink.primary)
                        .lineLimit(4)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(AceDesign.Space.row)
                        .background(AceTheme.Colours.fill, in: AceShape.field)
                        .accessibilityLabel("Code: \(draft.excerpt)")
                }
                TextField("What should the agent do here?", text: $comment, axis: .vertical)
                    .lineLimit(3...8)
                    .padding(AceDesign.Space.row)
                    .background(AceTheme.Colours.fill, in: AceShape.field)
                    .focused($focused)
                    .accessibilityIdentifier("file.note.comment")
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .padding(.horizontal, AceDesign.Space.margin).padding(.top, AceDesign.Space.related)
            .background(AceTheme.Colours.background)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(draft.existing == nil ? "Add" : "Save") {
                        save(comment.trimmingCharacters(in: .whitespacesAndNewlines))
                        dismiss()
                    }
                    .accessibilityIdentifier("file.note.save")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear { focused = true }
    }
}

/// The open file's notes on the next message, as one glass capsule over the text: “Note on
/// line 12” or “3 notes”. Each note goes to its line, changes its words or leaves; Send notes
/// to agent goes back to the thread's composer, where they wait with the message.
struct FileNotesChip: View {
    /// A note with its number on the message.
    struct Numbered: Identifiable {
        let number: Int
        let note: CodeNote
        var id: String { note.id }
    }
    let notes: [Numbered]
    let go: (CodeNote) -> Void
    let edit: (CodeNote) -> Void
    let remove: (CodeNote) -> Void
    let handOff: (() -> Void)?

    static func lines(_ note: CodeNote) -> String {
        let lines = note.lines
        return lines.count == 1 ? "line \(lines.lowerBound)" : "lines \(lines.lowerBound)–\(lines.upperBound)"
    }
    private var label: String {
        if notes.count == 1, let only = notes.first { return "Note on \(Self.lines(only.note))" }
        return "\(notes.count) notes"
    }

    var body: some View {
        Menu {
            ForEach(notes) { entry in
                let (number, note) = (entry.number, entry.note)
                Menu("\(number) · \(Self.lines(note))\(note.outdated ? " (outdated)" : "")\(note.comment.isEmpty ? "" : ": \(note.comment)")") {
                    Button("Go to note", ace: .arrowRight) { go(note) }
                    Button("Edit note", ace: .pencilSimple) { edit(note) }
                    Button("Remove note", ace: .x, role: .destructive) { remove(note) }
                }
            }
            if let handOff {
                Section { Button("Send notes to agent", ace: .arrowUp, action: handOff) }
            }
        } label: {
            HStack(spacing: AceDesign.Space.tight) {
                AceIcon(.notePencil)
                Text(label).monospacedDigit()
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.foreground)
            .padding(.horizontal, AceTheme.Spacing.lg)
            .frame(minHeight: AceDesign.Size.tap)
            .contentShape(AceShape.capsule)
        }
        .floatingGlass()
        .sensoryFeedback(.selection, trigger: notes.count)
        .accessibilityLabel(label)
        .accessibilityHint("Notes on this file's code for the thread's next message")
        .accessibilityIdentifier("file.notes")
    }
}
