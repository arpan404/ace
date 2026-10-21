import SwiftUI

/// Other transcript lists use the same work disclosure as the conversation feed.
struct TranscriptBlockRows: View {
    @Bindable var block: BlockModel
    let thread: ThreadModel
    let links: TranscriptLinks

    var body: some View {
        BlockView(block: block, thread: thread, links: links)
            .id(block.id).transcriptRow()
    }
}

extension View {
    func transcriptControlRow() -> some View {
        listRowSeparator(.hidden)
            .listRowBackground(AceTheme.Colours.background)
            .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: AceTheme.Spacing.xl, bottom: AceTheme.Spacing.none, trailing: AceTheme.Spacing.xl))
    }
}

private extension View {
    func transcriptRow() -> some View {
        listRowSeparator(.hidden)
            .listRowBackground(AceTheme.Colours.background)
            .listRowInsets(EdgeInsets(top: AceTheme.Spacing.xs, leading: AceTheme.Spacing.xl, bottom: AceTheme.Spacing.xs, trailing: AceTheme.Spacing.xl))
    }
}

/// Stable message shapes while the first bounded snapshot crosses the bridge.
struct ConversationSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxl) {
            HStack {
                Spacer(minLength: AceTheme.Spacing.xxxl)
                RoundedRectangle(cornerRadius: AceTheme.Radii.bubble)
                    .fill(AceTheme.Colours.fill)
                    .frame(height: AceTheme.Dimensions.touchTarget)
                    .containerRelativeFrame(.horizontal) { width, _ in width * 0.6 }
            }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
                Capsule().fill(AceTheme.Colours.fill).frame(height: AceTheme.Spacing.sm)
                Capsule().fill(AceTheme.Colours.fill).frame(height: AceTheme.Spacing.sm)
                Capsule().fill(AceTheme.Colours.fill).frame(height: AceTheme.Spacing.sm)
                    .containerRelativeFrame(.horizontal) { width, _ in width * 0.7 }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading conversation")
        .accessibilityIdentifier("transcript.loading")
    }
}
