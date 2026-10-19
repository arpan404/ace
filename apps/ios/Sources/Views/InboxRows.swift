import SwiftUI

/// One thread in the inbox: project and status, title, then branch, machine, tree size and when
/// it last worked (or wakes). Every word arrives from the bridge; colour comes from its token.
/// The machine shows only when more than one is paired (DESIGN.md list rows).
struct InboxThreadRow: View {
    let row: ThreadRow
    let snoozed: Bool
    var machine: String? = nil
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        // At accessibility text sizes the side-by-side lines stack, so nothing is cut off.
        let stacked = typeSize.isAccessibilitySize
        let lines = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceTheme.Spacing.xxs))
                            : AnyLayout(HStackLayout(spacing: AceTheme.Spacing.sm))
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            lines {
                HStack(spacing: AceTheme.Spacing.sm) {
                    Text(row.badge ?? "")
                        .aceFont(AceTheme.Typography.label, relativeTo: .caption)
                        .padding(AceTheme.Spacing.xs)
                        .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.small))
                        .accessibilityLabel(row.project)
                    Image(systemName: "folder").aceFont(AceTheme.Typography.caption, relativeTo: .caption).accessibilityHidden(true)
                    Text(row.project).aceFont(AceTheme.Typography.caption, relativeTo: .caption).lineLimit(stacked ? nil : 1)
                }
                if !stacked { Spacer(minLength: AceTheme.Spacing.sm) }
                StateLabel(status: row.status)
            }.foregroundStyle(AceTheme.Colours.mutedForeground)
            Text(row.title).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(stacked ? nil : 2)
            lines {
                if !row.branch.isEmpty { Text(row.branch).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption).lineLimit(stacked ? nil : 1) }
                if let machine, !machine.isEmpty { Text(row.branch.isEmpty || stacked ? machine : "· \(machine)").aceFont(AceTheme.Typography.caption, relativeTo: .caption).lineLimit(1) }
                if !stacked { Spacer(minLength: AceTheme.Spacing.none) }
                if row.agents > 1 {
                    Label("\(row.agents) agents", systemImage: "point.3.connected.trianglepath.dotted")
                        .labelStyle(.titleAndIcon).aceFont(AceTheme.Typography.caption, relativeTo: .caption).lineLimit(1)
                }
                Text(when).aceFont(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit().lineLimit(1)
            }.foregroundStyle(AceTheme.Colours.mutedForeground)
        }
        .padding(.vertical, AceTheme.Spacing.sm)
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
    /// Native date formatting of the bridge's timestamps; no state is derived here.
    private var when: String {
        if snoozed, let until = row.snoozedUntil {
            let date = Date(timeIntervalSince1970: until / 1000)
            let time = date.formatted(date: .omitted, time: .shortened)
            return Calendar.current.isDateInToday(date) ? "Until \(time)" : "Until \(date.formatted(.dateTime.weekday(.abbreviated))) \(time)"
        }
        return ActivityTime.text(Date(timeIntervalSince1970: (row.activityAt ?? row.updatedAt) / 1000), now: Date())
    }
}

/// A send the SDK still holds: the thread's project, the shared unsent wording, the text.
struct InboxUnsentRow: View {
    let entry: PendingRow
    let thread: ThreadRow?
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Image(systemName: "folder").aceFont(AceTheme.Typography.caption, relativeTo: .caption).accessibilityHidden(true)
                Text(thread?.project ?? "").aceFont(AceTheme.Typography.caption, relativeTo: .caption).lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                Text(entry.label ?? "").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(StateStyle.text(entry.token ?? "neutral"))
            }.foregroundStyle(AceTheme.Colours.mutedForeground)
            Text(entry.text).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
            if let thread { Text(thread.title).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1) }
        }
        .padding(.vertical, AceTheme.Spacing.sm)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// "Needs you ─── 2": a section's shared label, a rule and its count.
struct InboxSectionHeader: View {
    let title: String
    let count: Int
    var body: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            Text(title).aceFont(AceTheme.Typography.label, relativeTo: .caption).textCase(nil)
            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
            Text(count.formatted()).aceFont(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit()
        }
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .padding(.vertical, AceTheme.Spacing.xxs)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// The connection as the inbox shows it: quiet while connecting, a retry when it can't reach.
struct InboxConnectionBanner: View {
    let connection: String
    /// Which machine, when more than one is paired; the others' rows stay as they are.
    var machine: String? = nil
    let retry: () -> Void
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if waiting { ProgressView().controlSize(.mini) } else { Image(systemName: "wifi.slash") }
            Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            Spacer(minLength: AceTheme.Spacing.sm)
            if !waiting { Button("Retry", action: retry).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).buttonStyle(.borderless) }
        }
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(machine.map { "inbox.connection.\($0)" } ?? "inbox.connection")
    }
    private var waiting: Bool { connection == "connecting" || connection == "starting" }
    private var message: String {
        let state = switch connection {
        case "fatal": "Connection needs attention"
        case "offline", "reconnecting": "Offline · showing what this phone last saw"
        default: machine == nil ? "Connecting to your machine…" : "Connecting…"
        }
        return machine.map { "\($0) · \(state)" } ?? state
    }
}
