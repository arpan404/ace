import Observation
import SwiftUI

/// Editing a message that hasn't gone yet, in place: its full words are read first (never the
/// transcript's preview), and Save changes them where the message waits, in the daemon's queue or
/// in the phone's outbox. Nothing is removed to edit it. A refused save keeps the sheet open with
/// the person's words and says why; Cancel changes nothing.
@MainActor @Observable final class MessageEditor {
    var text = ""
    /// Why the words couldn't be read or saved; nil while all is well.
    private(set) var problem: String?
    private(set) var loaded = false
    private(set) var saving = false
    /// Files and images on the message: they stay with it whatever the words become.
    let attachments: Int
    @ObservationIgnored private let read: () async -> WordsRequests.Answer
    @ObservationIgnored private let write: (String) async -> String?

    /// `write` answers nil once the new words are saved, else why not.
    init(attachments: Int, read: @escaping () async -> WordsRequests.Answer, write: @escaping (String) async -> String?) {
        self.attachments = attachments
        self.read = read
        self.write = write
    }
    var canSave: Bool { loaded && !saving && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    func load() async {
        guard !loaded else { return }
        let answer = await read()
        if let words = answer.text { text = words; loaded = true; problem = nil } else { problem = answer.message }
    }
    /// True once saved (the sheet closes); false keeps the sheet and the words as they are.
    func save() async -> Bool {
        guard canSave else { return false }
        saving = true
        defer { saving = false }
        if let refusal = await write(text) { problem = refusal; return false }
        problem = nil
        return true
    }
}

/// The sheet: a fixed header (Cancel, the title, Save) that stays put while the words scroll under
/// the keyboard, then the words, what stays with the message, and why a save didn't go.
struct MessageEditSheet: View {
    @State var editor: MessageEditor
    @State private var saved = 0
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            header
            if editor.loaded {
                TextEditor(text: $editor.text)
                    .aceFont(AceTheme.Typography.body, relativeTo: .body)
                    .scrollContentBackground(.hidden)
                    .focused($focused)
                    .accessibilityLabel("Message")
                    .accessibilityIdentifier("edit.text")
                    .transition(.opacity)
            } else if editor.problem == nil {
                // Loading: the field's place, not a spinner (DESIGN.md §3).
                AceShape.capsule.fill(AceTheme.Colours.fill).frame(height: AceTheme.Spacing.lg).frame(maxWidth: 240)
                    .accessibilityLabel("Loading the message")
            }
            if editor.attachments > 0 {
                Text(editor.attachments == 1 ? "Its file stays with it." : "Its \(editor.attachments) files stay with it.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            if let problem = editor.problem {
                Text(problem)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .accessibilityIdentifier("edit.problem")
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.sm)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AceTheme.Colours.background)
        .animation(.smooth(duration: 0.2), value: editor.loaded)
        .animation(.smooth(duration: 0.2), value: editor.problem)
        .task {
            await editor.load()
            focused = editor.loaded
        }
        .sensoryFeedback(.success, trigger: saved)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(editor.saving)
    }
    private var header: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            Button("Cancel") { dismiss() }
                .buttonStyle(StripTextButtonStyle())
                .padding(.leading, -AceTheme.Spacing.sm)
                .accessibilityIdentifier("edit.cancel")
            Spacer(minLength: AceTheme.Spacing.none)
            Text("Edit message").aceFont(AceTheme.Typography.label, relativeTo: .headline)
                .foregroundStyle(AceTheme.Colours.foreground)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: AceTheme.Spacing.none)
            Button("Save") {
                Task { if await editor.save() { saved += 1; dismiss() } }
            }
            .buttonStyle(StripTextButtonStyle(prominent: true))
            .padding(.trailing, -AceTheme.Spacing.sm)
            .disabled(!editor.canSave)
            .accessibilityIdentifier("edit.save")
        }
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
    }
}

extension MessageEditor: Identifiable {
    nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }
}
