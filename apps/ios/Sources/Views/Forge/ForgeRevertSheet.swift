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
            ScrollView {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
                    Text("A draft pull request that undoes #\(number). Its diff and checks run before anything merges.").meta().lineLimit(nil).fixedSize(horizontal: false, vertical: true)
                    TextField("Title", text: $title)
                        .aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .padding(AceTheme.Spacing.md)
                        .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.lg, style: .continuous))
                        .accessibilityIdentifier("forge.revert.title")
                    ForgeEditor(text: $body_, placeholder: "Description", minLines: 5)
                        .accessibilityIdentifier("forge.revert.body")
                    if let outcome {
                        Text(outcome.uncertain ? "\(outcome.message) Pull down on the page to read GitHub again before trying again." : outcome.message)
                            .meta(outcome.ok ? AceTheme.Colours.mutedForeground : AceTone.failed.text)
                            .accessibilityIdentifier("forge.revert.outcome")
                            .transition(.opacity)
                    }
                }
                .padding(AceTheme.Spacing.lg)
            }
            .background(AceTheme.Colours.background)
            .animation(AceMotion.smooth, value: outcome)
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { primary }
            .navigationTitle("Revert #\(number)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(outcome?.ok == true ? "Done" : "Cancel") { dismiss() } }
            }
            .confirmationDialog("Open a draft that reverts #\(number)?", isPresented: $asking, titleVisibility: .visible) {
                Button("Open revert draft") { send() }
            }
            .sensoryFeedback(.success, trigger: outcome) { _, now in now?.ok == true }
            .interactiveDismissDisabled(writing)
        }
        .presentationDetents([.medium, .large])
    }

    /// The one control: open the draft, then open what GitHub made.
    @ViewBuilder private var primary: some View {
        Group {
            if let opened = outcome?.opened {
                capsule("Open #\(opened)", identifier: "forge.revert.open") { dismiss(); openPull(opened) }
            } else {
                capsule("Open revert draft", busy: writing, identifier: "forge.revert.create") { asking = true }
                    .disabled(writing || title.trimmingCharacters(in: .whitespaces).isEmpty || title.count > 256 || body_.count > 60_000)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
        .background(AceTheme.Colours.background)
    }

    private func capsule(_ label: String, busy: Bool = false, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Text(label).fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
        .tint(AceTheme.Colours.foreground).foregroundStyle(AceTheme.Colours.background)
        .accessibilityIdentifier(identifier)
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
