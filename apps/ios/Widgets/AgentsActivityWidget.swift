import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The one Live Activity for all of the person's agents. Lock Screen: the sentence ("2 need you
/// · 4 working") and up to three threads. Dynamic Island: the needs-you sparkle and its count
/// (or the working ring and its count), the most urgent mark when minimal, and when expanded the
/// approval waiting longest with Allow and Deny, or the threads.
struct AgentsActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentsActivityAttributes.self) { context in
            // The raised surface, not the system's translucent default: over an arbitrary
            // wallpaper that one can land mid-grey, where no ink tier holds 3:1.
            LockActivityView(summary: context.state, stale: context.isStale)
                .activityBackgroundTint(AceTheme.Colours.card)
                .activitySystemActionForegroundColor(AceTheme.Colours.foreground)
        } dynamicIsland: { context in
            let summary = context.state
            let stale = context.isStale
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    SummaryGlyph(summary: summary, size: LockType.islandGlyph)
                        .padding(.leading, AceTheme.Spacing.xs)
                }
                DynamicIslandExpandedRegion(.center) {
                    LockHeadline(summary: summary, stale: stale, trailing: "")
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let request = summary.request, summary.current, !summary.asOf(stale: stale) {
                        RequestView(request: request)
                    } else {
                        LockRowsList(summary: summary.limited(3), stale: stale)
                    }
                }
            } compactLeading: {
                SummaryGlyph(summary: summary, size: LockType.islandGlyph)
            } compactTrailing: {
                CompactCount(summary: summary)
            } minimal: {
                SummaryGlyph(summary: summary, size: LockType.islandGlyph)
            }
            .widgetURL(summary.rows.first.flatMap { URL(string: $0.link) })
        }
    }
}
