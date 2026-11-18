import SwiftUI

/// The commit a merge or squash writes, to edit before it goes: GitHub's prefill for this
/// account, its title and message, or the draft kept from the last time. What is confirmed here
/// is what GitHub writes, at the head the page showed. If the head moves while it's open, the
/// edits are kept when it closes (`keep`), and Merge reopens on them at the new head.
struct ForgeMergeCommitSheet: View {
    @State var target: ForgeWriteTarget
    /// GitHub's own title and message: only a change from them is a draft.
    let prefill: ForgePullPage.MergeCommit?
    let title: String
    var current = true
    @State private var discarding = false
    /// GitHub's text as it was when the sheet opened. A later prefill (the head moved) must not
    /// turn untouched text into a draft that would then replace the new default.
    @State private var opening: ForgePullPage.MergeCommit?
    @State private var opened = false
    /// Keeps the commit for the next opening, or forgets the draft when nil.
    let keep: (ForgePullPage.MergeCommit?) -> Void
    let confirm: (ForgeWriteTarget) -> Void
    @Environment(\.dismiss) private var dismiss

    private var commitTitle: Binding<String> {
        Binding(get: { target.commit?.title ?? "" }, set: { target.commit?.title = $0 })
    }
    private var commitMessage: Binding<String> {
        Binding(get: { target.commit?.message ?? "" }, set: { target.commit?.message = $0 })
    }

    private var edited: Bool { target.commit != (opened ? opening : prefill) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
                    Text(title).meta().lineLimit(2)
                    if !current { Text("The pull request changed. Your draft is saved. Reopen Merge to continue.").meta() }
                    TextField("Commit title", text: commitTitle)
                        .aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .padding(AceTheme.Spacing.md)
                        .background(AceTheme.Colours.fill, in: AceDesign.Shape.field)
                        .accessibilityIdentifier("forge.commit.title")
                    ForgeEditor(text: commitMessage, placeholder: "Commit message", minLines: 4)
                }
                .padding(AceTheme.Spacing.lg)
            }
            .background(AceTheme.Colours.background)
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
                Button { if current { keep(nil); confirm(target) } } label: {
                    Text(target.action.label).fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
                }
                .buttonStyle(.textAction(.prominent))
                .disabled(!current || commitTitle.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
                .background(AceTheme.Colours.background)
                .accessibilityIdentifier("forge.commit.confirm")
            }
            .navigationTitle("Commit")
            .navigationBarTitleDisplayMode(.inline)
            // Once the head moved the draft can't be sent here, so closing keeps it rather than
            // asking to discard it.
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { if edited && current { discarding = true } else { dismiss() } } } }
        }
        .interactiveDismissDisabled(edited && current)
        .onAppear { if !opened { opening = prefill; opened = true } }
        .onDisappear { if edited && !current { keep(target.commit) } }
        .confirmationDialog("Discard draft?", isPresented: $discarding, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { keep(nil); dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .presentationDetents([.medium, .large])
    }
}
