import SwiftUI
import WidgetKit

struct LockProvider: TimelineProvider {
    /// The app writes a new snapshot and reloads widgets whenever the inbox changes; this
    /// re-read only moves the "as of" check along when the app is away.
    static let reread: TimeInterval = 15 * 60
    func placeholder(in context: Context) -> LockEntry { LockEntry(date: .now, summary: .preview) }
    func getSnapshot(in context: Context, completion: @escaping (LockEntry) -> Void) {
        completion(LockEntry(date: .now, summary: context.isPreview ? LockSnapshotStore.read() ?? .preview : LockSnapshotStore.read()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LockEntry>) -> Void) {
        let now = Date.now
        let summary = LockSnapshotStore.read()
        var entries = [LockEntry(date: now, summary: summary)]
        // A second entry at the moment the snapshot stops counting as fresh, so it turns to
        // "as of" on time even when the app isn't running to rewrite it.
        if let summary, summary.live {
            let stale = summary.updatedAt.addingTimeInterval(LockSummary.freshFor + 1)
            if stale > now { entries.append(LockEntry(date: stale, summary: summary)) }
        }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(Self.reread))))
    }
}

/// The inbox on the Home Screen. Small: how many need you and the top thread. Medium: the
/// sentence and three threads. Large: six. Each thread opens in ace.
struct InboxWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.ace.ios.inbox", provider: LockProvider()) { entry in
            InboxWidgetView(entry: entry)
                .containerBackground(AceTheme.Colours.background, for: .widget)
        }
        .configurationDisplayName("Inbox")
        .description("What needs you and what's working.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
