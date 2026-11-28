import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// One paired machine's Live Activity (ADR 0223). Counts come from the content, which its daemon
/// may have pushed; the machine's name, its threads and Allow/Deny come from the app's snapshot
/// only when it goes with those counts (`MachineActivityLook`). Lock Screen: the sentence ("1
/// needs you · 2 working"), the machine's name, and up to three threads. Dynamic Island: the
/// needs-you sparkle and its count (or the working ring and its count), and when expanded the
/// approval waiting longest with Allow and Deny, or the threads.
struct MachineActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MachineActivityAttributes.self) { context in
            let look = Self.look(context.attributes, context.state, stale: context.isStale)
            // The raised surface, not the system's translucent default: over an arbitrary
            // wallpaper that one can land mid-grey, where no ink tier holds 3:1.
            VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                MachineHeadline(look: look)
                LockRowsList(summary: look.summary, stale: look.stale)
            }
            .padding(AceTheme.Spacing.lg)
            .widgetURL(look.rows.first.flatMap { URL(string: $0.link) })
            .activityBackgroundTint(AceTheme.Colours.card)
            .activitySystemActionForegroundColor(AceTheme.Colours.foreground)
        } dynamicIsland: { context in
            let look = Self.look(context.attributes, context.state, stale: context.isStale)
            let summary = look.summary
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    SummaryGlyph(summary: summary, size: LockType.islandGlyph)
                        .padding(.leading, AceTheme.Spacing.xs)
                }
                DynamicIslandExpandedRegion(.center) {
                    MachineHeadline(look: look)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let request = look.request {
                        RequestView(request: request)
                    } else {
                        LockRowsList(summary: summary, stale: look.stale)
                    }
                }
            } compactLeading: {
                SummaryGlyph(summary: summary, size: LockType.islandGlyph)
            } compactTrailing: {
                CompactCount(summary: summary)
            } minimal: {
                SummaryGlyph(summary: summary, size: LockType.islandGlyph)
            }
            .widgetURL(look.rows.first.flatMap { URL(string: $0.link) })
        }
    }

    private static func look(_ attributes: MachineActivityAttributes, _ state: MachineActivityAttributes.ContentState,
                             stale: Bool) -> MachineActivityLook {
        MachineActivityLook(state: state, snapshot: MachineSnapshotStore.read(slot: attributes.slot), stale: stale)
    }
}

/// The machine's sentence, then its name, "Open ace for details" when the snapshot doesn't go
/// with the counts, or "as of" their time once stale.
struct MachineHeadline: View {
    let look: MachineActivityLook
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            Text(look.headline)
                .font(LockType.body.weight(LockType.strong))
                .foregroundStyle(AceTheme.Colours.foreground)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(look.note)
                .font(LockType.meta)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(1)
                .layoutPriority(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(look.spoken)
    }
}
