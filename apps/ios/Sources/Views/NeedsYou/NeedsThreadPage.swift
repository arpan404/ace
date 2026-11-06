import SwiftUI

/// A run page for a thread that needs the person with nothing the phone can answer from here
/// (a message that wasn't sent, a model to choose): where it is, what it waits on in the row's
/// own words, and Open thread in thumb reach. Skip moves past it; it leaves the run only when the
/// daemon stops listing the thread as needing the person.
struct NeedsThreadPage: View {
    let row: ThreadRow
    let machine: String?
    let open: () -> Void

    var body: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                    HStack(spacing: AceDesign.Space.related) {
                        ProviderMark(provider: row.provider, size: AceDesign.Size.rowMark)
                            .opacity(AceDesign.Ink.markOpacity)
                        Text(origin)
                            .aceFont(InboxRowType.line, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.subtleForeground)
                            .lineLimit(1).truncationMode(.middle)
                    }
                    .accessibilityElement(children: .combine)
                    Text(row.hover?.sentence ?? row.look?.meaning ?? "Needs you")
                        .aceFont(AceDesign.TextRole.header, relativeTo: .headline)
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("run.sentence")
                    if let detail = row.hover?.detail, !detail.isEmpty {
                        Text(detail)
                            .aceFont(AceDesign.TextRole.segment, relativeTo: .subheadline)
                            .monospaced(row.hover?.code == true)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                            .lineLimit(4)
                    }
                    Text(row.title)
                        .aceFont(InboxRowType.title, relativeTo: .callout)
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .lineLimit(2)
                        .padding(.top, AceDesign.Space.group - AceDesign.Space.related)
                }
                .padding(.horizontal, AceDesign.Space.margin)
                .padding(.top, AceDesign.Space.row)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            Button("Open thread", action: open)
                .buttonStyle(PillButtonStyle(kind: .primary))
                .padding(.horizontal, AceDesign.Space.margin)
                .padding(.vertical, AceDesign.Space.related)
                .accessibilityIdentifier("run.open")
        }
    }

    /// Project · branch, and the machine where there are several.
    private var origin: String {
        [row.project, row.branchLabel ?? row.branch, machine ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
