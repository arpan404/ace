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
