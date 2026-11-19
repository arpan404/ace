import SwiftUI

/// A centred line between two hairlines, where the conversation itself changes hands: a context
/// handoff to another model, or a fork's own work starting after the history it continues.
/// One muted caption line; the hairlines run to the column edges.
struct CentredDivider<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        HStack(spacing: AceDesign.Space.row) {
            rule
            HStack(spacing: AceDesign.Space.tight) { content }
                .lineLimit(1)
                .layoutPriority(1)
            rule
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .padding(.vertical, AceDesign.Space.tight)
    }
    private var rule: some View {
        Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
            .frame(minWidth: AceDesign.Space.group).accessibilityHidden(true)
    }
}

/// "⑂ Forked from <source title>": where a fork's copy of the conversation it continues ends and
/// its own work begins. The title is the thread list's, renames included, and opens the source;
/// when the list doesn't know the source, it reads "the earlier thread" and opens nothing.
struct ForkedDivider: View {
    let forked: BlockRow.Forked
    /// The source's title, when the thread list has it.
    let title: String?
    let open: (String) -> Void
    var body: some View {
        if let title {
            Button { open(forked.threadId) } label: { line(title, linked: true) }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Forked from \(title)")
                .accessibilityHint("Opens the thread it was forked from")
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier("transcript.forked")
        } else {
            line("the earlier thread", linked: false)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Forked from the earlier thread")
                .accessibilityIdentifier("transcript.forked")
        }
    }
    private func line(_ title: String, linked: Bool) -> some View {
        CentredDivider {
            AceIcon(.gitFork, size: AceDesign.Size.glyphSmall, relativeTo: .caption)
            Text("Forked from").fontWeight(AceDesign.Typeface.regular)
            // A title that opens reads one step up from the line, like a handoff's new model.
            Text(title)
                .foregroundStyle(linked ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                .truncationMode(.tail)
        }
        .contentShape(Rectangle())
    }
}
