import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// One machine’s activity on the Lock Screen and Dynamic Island.
struct AgentsActivityWidget: Widget {
    private let inbox = URL(string: "ace://inbox")

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MachineActivityAttributes.self) { context in
            let view = presentation(context)
            LockActivityView(summary: view.summary, stale: context.isStale, machineName: view.name,
                             detailHint: view.detailHint, fallbackURL: inbox)
                .activityBackgroundTint(AceTheme.Colours.card)
                .activitySystemActionForegroundColor(AceTheme.Colours.foreground)
        } dynamicIsland: { context in
            let view = presentation(context)
            let summary = view.summary
            let stale = context.isStale
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    SummaryGlyph(summary: summary, size: LockType.islandGlyph)
                        .padding(.leading, AceTheme.Spacing.xs)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        if let name = view.name { LockActivityCaption(text: name) }
                        LockHeadline(summary: summary, stale: stale, trailing: "")
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let request = summary.request, !summary.asOf(stale: stale) {
                        RequestView(request: request)
                    } else if let hint = view.detailHint {
                        LockActivityCaption(text: hint)
                    } else {
                        LockRowsList(summary: summary, stale: stale)
                    }
                }
            } compactLeading: {
                SummaryGlyph(summary: summary, size: LockType.islandGlyph)
            } compactTrailing: {
                CompactCount(summary: summary)
            } minimal: {
                SummaryGlyph(summary: summary, size: LockType.islandGlyph)
            }
            .widgetURL(summary.rows.first.flatMap { URL(string: $0.link) } ?? inbox)
        }
    }

    private func presentation(_ context: ActivityViewContext<MachineActivityAttributes>) -> MachineActivityPresentation {
        MachineActivityPresentation(state: context.state, snapshot: MachineActivitySnapshot.read(slot: context.attributes.slot))
    }
}
