import SwiftUI

/// The commit a merge or squash writes, to edit before it goes: GitHub's prefill for this
/// account, its title and message. What is confirmed here is what GitHub writes, at the head the
/// page showed.
struct ForgeMergeCommitSheet: View {
    @State var target: ForgeWriteTarget
    let title: String
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
                    TextField("Commit title", text: commitTitle)
                        .aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .padding(AceTheme.Spacing.md)
                        .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.lg, style: .continuous))
                        .accessibilityIdentifier("forge.commit.title")
                    ForgeEditor(text: commitMessage, placeholder: "Commit message", minLines: 4)
                }
                .padding(AceTheme.Spacing.lg)
            }
            .background(AceTheme.Colours.background)
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
                Button { confirm(target) } label: {
                    Text(target.action.label).fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                .tint(AceTheme.Colours.foreground).foregroundStyle(AceTheme.Colours.background)
                .disabled(commitTitle.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
                .background(AceTheme.Colours.background)
                .accessibilityIdentifier("forge.commit.confirm")
            }
            .navigationTitle("Commit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
