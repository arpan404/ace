import SwiftUI

/// One agent's part of the conversation: the thread's loaded rows that agent wrote. An agent
/// that runs as its own ace thread keeps its transcript there.
struct AgentTranscriptView: View {
    let row: AgentSheet.Row
    @Bindable var thread: ThreadModel
    private var rows: [TranscriptRow] {
        thread.order.compactMap { thread.items[$0]?.row }.filter { $0.agentId == row.id }
    }
    var body: some View {
        List {
            Section { AgentRowView(row: row) }
            if row.childThreadId != nil {
                Text("This agent runs as its own thread. Open it from the inbox to read its transcript.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            } else if rows.isEmpty {
                Text("Nothing from this agent in the loaded conversation yet.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            ForEach(rows) { item in
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    if item.type == "message" {
                        Text(item.text).aceFont(AceTheme.Typography.body, relativeTo: .body).textSelection(.enabled)
                    } else {
                        Label(item.text, systemImage: item.type == "tool_call" ? "wrench.and.screwdriver" : "text.alignleft")
                            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(3)
                    }
                    if item.truncated {
                        Text("Showing a bounded preview").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                }
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .navigationTitle(row.name)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("agents.transcript")
    }
}
