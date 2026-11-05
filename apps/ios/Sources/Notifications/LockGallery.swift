#if DEBUG
import SwiftUI
import WidgetKit

/// Debug builds only, launched with `--lock-gallery`: every lock-screen surface drawn with the
/// extension's own views at their system sizes, for design review. The simulator can't open the
/// Lock Screen, expand the Dynamic Island or add widgets on its own; this shows what they draw.
/// The rounded backdrops stand in for the system's containers; the Lock Screen one is the same
/// raised surface the activity sets as its tint.
struct LockGallery: View {
    static var requested: Bool { ProcessInfo.processInfo.arguments.contains("--lock-gallery") }
    /// Which part to show, so each fits one screenshot: `--lock-gallery-page 1…4`.
    private var page: Int {
        let args = ProcessInfo.processInfo.arguments
        guard let at = args.firstIndex(of: "--lock-gallery-page"), args.indices.contains(at + 1) else { return 1 }
        return Int(args[at + 1]) ?? 1
    }

    /// Page 4 draws what the hub built from the attached machines' real rows.
    @Environment(NotificationCoordinator.self) private var notifications: NotificationCoordinator?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxl) {
                switch page {
                case 2: widgets
                case 3: accessories
                case 4: live
                default: activity
                }
            }
            .padding(AceTheme.Spacing.lg)
        }
        .background(wallpaper)
    }

    private var current: LockSummary {
        var summary = LockSummary.preview
        summary.request = LockRequest(hostId: "", threadId: "a", interactionId: "i", approve: "allow", deny: "deny",
                                      sentence: "Claude Code wants to run a command", detail: "bun run test:changed",
                                      code: true, title: "Fleet map wire paths")
        return summary
    }
    private var stale: LockSummary {
        var summary = LockSummary.preview
        summary.current = false
        summary.live = false
        summary.updatedAt = Date.now.addingTimeInterval(-25 * 60)
        return summary
    }
    /// Eight busy threads where only three work, with one paired machine switched off: the
    /// counts say each state, and the offline machine is a note, not a stale mark.
    private var mixed: LockSummary {
        let now = Date.now
        func row(_ id: String, _ title: String, _ icon: String, _ tone: String, _ meaning: String, since: TimeInterval? = nil) -> LockRow {
            LockRow(id: id, hostId: "", title: title, icon: icon, tone: tone, meaning: meaning,
                    since: since.map { now.addingTimeInterval(-$0) }, link: "ace://thread/\(id)", needsYou: false)
        }
        return LockSummary(needsYou: 0, working: 3, waiting: 3, limited: 2, rows: [
            row("w1", "Fix-command-discovery-stalls", "working", "working", "Working", since: 412),
            row("w2", "Design a Polished iOS App Interface", "agents", "waiting", "Waiting on 2 agents", since: 1310),
            row("w3", "Usage limits as a quiet line", "working", "working", "Working", since: 95),
            row("q1", "Fleet-computer-use-over-machines", "waiting", "waiting", "Queued"),
            row("l1", "Offshift-person-controls", "limited", "limited", "Limited 9:00 AM"),
        ], current: false, live: true, offline: 1, busy: true, updatedAt: now)
    }
    private var quiet: LockSummary {
        LockSummary(needsYou: 0, working: 0, rows: [LockSummary.preview.rows[5]], current: true, busy: false, updatedAt: .now)
    }

    @ViewBuilder private var activity: some View {
        caption("Lock Screen")
        LockActivityView(summary: current.limited(3), stale: false).background(AceTheme.Colours.card, in: lockShape)
        caption("Lock Screen, three working among eight busy, one machine off")
        LockActivityView(summary: mixed.limited(3), stale: false).background(AceTheme.Colours.card, in: lockShape)
        caption("Lock Screen, last known (no machine answered)")
        LockActivityView(summary: stale.limited(3), stale: true).background(AceTheme.Colours.card, in: lockShape)
        caption("Lock Screen, all quiet")
        LockActivityView(summary: quiet, stale: false).background(AceTheme.Colours.card, in: lockShape)
        caption("Dynamic Island, expanded with a request")
        if let request = current.request { island { RequestView(request: request) } }
        caption("Dynamic Island, expanded with threads")
        island { LockRowsList(summary: stale.limited(3), stale: false) }
        caption("Dynamic Island, compact and minimal")
        HStack(spacing: AceTheme.Spacing.md) {
            HStack {
                SummaryGlyph(summary: current, size: LockType.islandGlyph)
                Spacer()
                CompactCount(summary: current)
            }
            .padding(.horizontal, AceTheme.Spacing.lg).frame(width: 250, height: 37).background(.black, in: Capsule())
            SummaryGlyph(summary: current, size: LockType.islandGlyph).frame(width: 37, height: 37).background(.black, in: Circle())
        }
        .environment(\.colorScheme, .dark)
    }

    /// The summary the Live Activity is sent now, re-read every second (the hub isn't observed).
    @ViewBuilder private var live: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let summary = notifications?.lockScreen.summary ?? .empty
            VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
                caption("Lock Screen, live from the attached machines")
                LockActivityView(summary: summary.limited(3), stale: false).background(AceTheme.Colours.card, in: lockShape)
                caption("Large widget, the same summary")
                widget(width: 364, height: 382) { ListInbox(summary: summary.limited(6), stale: false) }
            }
        }
    }

    @ViewBuilder private var widgets: some View {
        caption("Small")
        HStack(spacing: AceTheme.Spacing.xl) {
            widget(width: 170, height: 170) { SmallInbox(summary: current, stale: false) }
            widget(width: 170, height: 170) { SmallInbox(summary: stale, stale: true) }
        }
        caption("Medium")
        widget(width: 364, height: 170) { ListInbox(summary: current.limited(3), stale: false) }
        caption("Large")
        widget(width: 364, height: 382) { ListInbox(summary: current.limited(6), stale: false) }
    }

    @ViewBuilder private var accessories: some View {
        caption("Lock Screen widgets")
        HStack(spacing: AceTheme.Spacing.xl) {
            AccessoryCount(summary: current).frame(width: 72, height: 72)
            AccessoryTopThread(summary: current, now: .now).frame(width: 172, height: 76)
        }
        .foregroundStyle(.white)
        caption("Before the app has written anything, and not current")
        HStack(spacing: AceTheme.Spacing.xl) {
            AccessoryCount(summary: nil).frame(width: 72, height: 72)
            AccessoryTopThread(summary: stale, now: .now).frame(width: 172, height: 76)
        }
        .foregroundStyle(.white)
        caption("Medium, nothing yet")
        widget(width: 364, height: 170) { InboxWidgetView(entry: LockEntry(date: .now, summary: nil)) }
    }

    private var lockShape: some Shape { RoundedRectangle(cornerRadius: 24, style: .continuous) }
    private var wallpaper: some View {
        LinearGradient(colors: [Color(red: 0.11, green: 0.14, blue: 0.2), Color(red: 0.05, green: 0.07, blue: 0.09)],
                       startPoint: .top, endPoint: .bottom).ignoresSafeArea()
    }
    private func caption(_ text: String) -> some View {
        Text(text).font(LockType.caption).foregroundStyle(.white.opacity(0.6))
    }
    private func island<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            HStack(spacing: AceTheme.Spacing.sm) {
                SummaryGlyph(summary: current, size: LockType.islandGlyph)
                LockHeadline(summary: current, stale: false, trailing: "")
            }
            content()
        }
        .padding(AceTheme.Spacing.xl)
        .background(.black, in: RoundedRectangle(cornerRadius: 44, style: .continuous))
        .environment(\.colorScheme, .dark)
    }
    private func widget<Content: View>(width: CGFloat, height: CGFloat, @ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(AceTheme.Spacing.lg)
            .frame(width: width, height: height)
            .background(AceTheme.Colours.background, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}
#endif
