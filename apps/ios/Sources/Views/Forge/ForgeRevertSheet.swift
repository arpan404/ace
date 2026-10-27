import SwiftUI

/// Reverting a merged pull request: a separate draft pull request that undoes it, whose title
/// and description the person reads over first (the web's revert form). It is asked once more
/// before it goes, and sent once; what GitHub opened is read back, never assumed.
struct ForgeRevertSheet: View {
    let number: Int
    @State var title: String
    @State var body_: String
    let create: (String, String) async -> ForgeWorkOutcome
    let openPull: (Int) -> Void
    @State private var asking = false
    @State private var writing = false
    @State private var outcome: ForgeWorkOutcome?
    @Environment(\.dismiss) private var dismiss

    init(number: Int, draft: ForgeManage.Revert, create: @escaping (String, String) async -> ForgeWorkOutcome, openPull: @escaping (Int) -> Void) {
        self.number = number
        _title = State(initialValue: draft.title)
        _body_ = State(initialValue: draft.body)
        self.create = create
        self.openPull = openPull
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Opens a draft pull request that reverts #\(number). Its diff, reviews and required checks can be looked over before it merges.")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                Section("Title") {
                    TextField("Title", text: $title).accessibilityIdentifier("forge.revert.title")
                }
                Section("Description") {
                    TextEditor(text: $body_).frame(minHeight: 140).accessibilityIdentifier("forge.revert.body")
                }
                if let outcome {
                    Section {
                        Text(outcome.uncertain ? "\(outcome.message) Pull down on the page to read GitHub again before trying again." : outcome.message)
                            .foregroundStyle(outcome.ok ? AceTheme.Colours.foreground : AceTone.failed.text)
                            .accessibilityIdentifier("forge.revert.outcome")
                        if let opened = outcome.opened {
                            Button("Open #\(opened)") { dismiss(); openPull(opened) }.accessibilityIdentifier("forge.revert.open")
                        }
                    }
                    .transition(.opacity)
                }
            }
            .animation(.smooth, value: outcome)
            .navigationTitle("Revert #\(number)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(outcome?.ok == true ? "Done" : "Cancel") { dismiss() } }
                if outcome?.ok != true {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Create", role: .destructive) { asking = true }
                            .disabled(writing || title.trimmingCharacters(in: .whitespaces).isEmpty || title.count > 256 || body_.count > 60_000)
                            .accessibilityIdentifier("forge.revert.create")
                    }
                }
            }
            .confirmationDialog("Open a draft that reverts #\(number)?", isPresented: $asking, titleVisibility: .visible) {
                Button("Create revert pull request", role: .destructive) { send() }
            }
            .sensoryFeedback(.success, trigger: outcome) { _, now in now?.ok == true }
            .interactiveDismissDisabled(writing)
        }
    }

    private func send() {
        guard !writing else { return }
        writing = true
        Task {
            outcome = await create(title, body_)
            writing = false
        }
    }
}
