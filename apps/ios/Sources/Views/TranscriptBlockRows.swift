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
            .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: AceDesign.Space.margin, bottom: AceTheme.Spacing.none, trailing: AceDesign.Space.margin))
    }
}

private extension View {
    func transcriptRow() -> some View {
        listRowSeparator(.hidden)
            .listRowBackground(AceTheme.Colours.background)
            .listRowInsets(EdgeInsets(top: AceDesign.Space.tight, leading: AceDesign.Space.margin, bottom: AceDesign.Space.tight, trailing: AceDesign.Space.margin))
    }
}

/// Stable message shapes while the first bounded snapshot crosses the bridge.
struct ConversationSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.group) {
            HStack {
                Spacer(minLength: AceDesign.Space.section)
                AceShape.bubble
                    .fill(AceTheme.Colours.fill)
                    .frame(height: AceDesign.Size.tap)
                    .containerRelativeFrame(.horizontal) { width, _ in width * 0.6 }
            }
            VStack(alignment: .leading, spacing: AceDesign.Space.row) {
                AceShape.capsule.fill(AceTheme.Colours.fill).frame(height: AceDesign.Space.related)
                AceShape.capsule.fill(AceTheme.Colours.fill).frame(height: AceDesign.Space.related)
                AceShape.capsule.fill(AceTheme.Colours.fill).frame(height: AceDesign.Space.related)
                    .containerRelativeFrame(.horizontal) { width, _ in width * 0.7 }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading conversation")
        .accessibilityIdentifier("transcript.loading")
    }
}
