import ActivityKit
import SwiftUI
import WidgetKit

@main struct ThreadActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ThreadActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                Text(context.state.title).font(.headline).lineLimit(2)
                Label(label(context), ace: symbol(context))
                Text(context.state.updatedAt, style: .time).font(.caption).foregroundStyle(.secondary)
            }.padding(AceTheme.Spacing.lg)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Text("ace.").font(.headline) }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading) {
                        Text(context.state.title).lineLimit(2)
                        Label(label(context), ace: symbol(context)).font(.caption)
                    }
                }
            } compactLeading: { Text("ace.") } compactTrailing: { AceIcon(symbol(context), size: 16) } minimal: { AceIcon(symbol(context), size: 16) }
        }
    }
    private func label(_ context: ActivityViewContext<ThreadActivityAttributes>) -> String {
        if context.isStale { return "Open ace to refresh" }
        if !context.state.online { return "Offline · open ace to refresh" }
        // Old activities decode without confirmation; they read as unconfirmed and never as done.
        if context.state.confirmed != true { return "Syncing · open ace to refresh" }
        return context.state.label
    }
    private func symbol(_ context: ActivityViewContext<ThreadActivityAttributes>) -> AceIcon.Name {
        if context.isStale || !context.state.online { return .wifiSlash }
        if context.state.confirmed != true { return .dotsThreeCircle }
        return context.state.token == "needsYou" ? .hand : context.state.token == "done" ? .checkCircle : .dotsThreeCircle
    }
}
