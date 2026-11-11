import SwiftUI

/// The commit a merge or squash writes, to edit before it goes: GitHub's prefill for this
/// account, its title and message. What is confirmed here is what GitHub writes, at the head the
/// page showed.
struct ForgeMergeCommitSheet: View {
    @State var target: ForgeWriteTarget
    let title: String
    var current = true
    @State private var discarding = false
    let confirm: (ForgeWriteTarget) -> Void
    @Environment(\.dismiss) private var dismiss

    private var commitTitle: Binding<String> {
        Binding(get: { target.commit?.title ?? "" }, set: { target.commit?.title = $0 })
    }
    private var commitMessage: Binding<String> {
        Binding(get: { target.commit?.message ?? "" }, set: { target.commit?.message = $0 })
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
                    Text(title).meta().lineLimit(2)
                    if !current { Text("Pull request changed. Your draft is kept here; merging is disabled for this head or method.").meta() }
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
                Button { if current { confirm(target) } } label: {
                    Text(target.action.label).fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
                }
                .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                .tint(AceTheme.Colours.foreground).foregroundStyle(AceTheme.Colours.background)
                .disabled(!current || commitTitle.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
                .background(AceTheme.Colours.background)
                .accessibilityIdentifier("forge.commit.confirm")
            }
            .navigationTitle("Commit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { if commitTitle.wrappedValue.isEmpty && commitMessage.wrappedValue.isEmpty { dismiss() } else { discarding = true } } } }
        }
        .interactiveDismissDisabled(!commitTitle.wrappedValue.isEmpty || !commitMessage.wrappedValue.isEmpty)
        .confirmationDialog("Discard draft?", isPresented: $discarding, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .presentationDetents([.medium, .large])
    }
}
