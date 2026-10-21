import SwiftUI

/// One thread in the inbox, in three lines: project … status (and how long it has worked),
/// the title, then branch · pull request or machine … provider. Every word and token arrives
/// from the bridge; colour comes from its token. Rows that need the person stay loud; work in
/// progress recedes. The machine shows only when more than one is paired (DESIGN.md list rows).
struct InboxThreadRow: View {
    let row: ThreadRow
    let snoozed: Bool
    var machine: String? = nil
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Working and waiting rows recede: the person has nothing to do there yet.
    private var recedes: Bool { row.status.token == "working" || row.status.token == "waiting" }

    var body: some View {
        // At accessibility text sizes the side-by-side lines stack, so nothing is cut off.
        let stacked = typeSize.isAccessibilitySize
        let lines = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceTheme.Spacing.xxs))
                            : AnyLayout(HStackLayout(spacing: 7))
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            lines {
                if !row.project.isEmpty {
                    HStack(spacing: 7) {
                        ProjectTag(initials: row.badge ?? row.project)
                        Text(row.project).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).lineLimit(stacked ? nil : 1)
                    }
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .opacity(recedes ? 0.7 : 1)
                }
                if !stacked { Spacer(minLength: AceTheme.Spacing.sm) }
                status
            }
            .frame(minHeight: 20)
            Text(row.title)
                .aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                .fontWeight(recedes ? .regular : .medium)
                .foregroundStyle(recedes ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                .lineLimit(stacked ? nil : 1)
                .padding(.top, 3).padding(.bottom, AceTheme.Spacing.xs)
            lines {
                if !row.branch.isEmpty {
                    Text(row.branch).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .lineLimit(stacked ? nil : 1).truncationMode(.middle)
                }
                if let extra { Text(row.branch.isEmpty || stacked ? extra : "·  \(extra)").aceFont(AceTheme.Typography.caption, relativeTo: .caption).lineLimit(1) }
                if !stacked { Spacer(minLength: AceTheme.Spacing.sm) }
                providers
            }
            .foregroundStyle(AceTheme.Colours.subtleForeground)
            .frame(minHeight: 18)
            .opacity(recedes ? 0.7 : 1)
        }
        .padding(.top, 11).padding(.bottom, AceTheme.Spacing.md)
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// The shared status word, then how long the tree has worked or when a snooze ends.
    private var status: some View {
        TimelineView(.everyMinute) { context in
            HStack(spacing: 5) {
                StateLabel(status: row.status)
                if let time = time(at: context.date) {
                    Text(time).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).monospacedDigit()
                        .foregroundStyle(snoozed ? AceTheme.Colours.subtleForeground : StateStyle.text(row.status.token))
                        .lineLimit(1)
                }
            }
        }
    }
    /// The pull request when the thread has one, else the machine when several are paired.
    private var extra: String? {
        if let pr = row.pr { return "#\(pr.number)" }
        if let machine, !machine.isEmpty { return machine }
        return nil
    }
    /// The thread's provider; a tree of several agents adds how many more there are.
    private var providers: some View {
        HStack(spacing: 3) {
            ProviderMark(provider: row.provider).foregroundStyle(AceTheme.Colours.mutedForeground)
            if row.agents > 1 {
                Text("+\(row.agents - 1)").aceFont(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit()
                    .accessibilityLabel("\(row.agents) agents")
            }
        }
        .opacity(0.75)
    }
    /// Native date formatting of the bridge's timestamps; no state is derived here.
    private func time(at now: Date) -> String? {
        if snoozed, let until = row.snoozedUntil {
            let date = Date(timeIntervalSince1970: until / 1000)
            let time = date.formatted(date: .omitted, time: .shortened)
            return Calendar.current.isDateInToday(date) ? "Until \(time)" : "Until \(date.formatted(.dateTime.weekday(.abbreviated))) \(time)"
        }
        if let since = row.workingSince { return ActivityTime.elapsed(since: Date(timeIntervalSince1970: since / 1000), now: now) }
        return nil
    }
}

/// A send the SDK still holds, drawn like a thread row: project … the shared unsent wording,
/// the text, then the thread it goes to.
struct InboxUnsentRow: View {
    let entry: PendingRow
    let thread: ThreadRow?
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            HStack(spacing: 7) {
                if let thread, !thread.project.isEmpty {
                    ProjectTag(initials: thread.badge ?? thread.project)
                    Text(thread.project).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).lineLimit(1)
                }
                Spacer(minLength: AceTheme.Spacing.sm)
                Text(entry.label ?? "").aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.semibold)
                    .foregroundStyle(StateStyle.text(entry.token ?? "neutral")).lineLimit(1)
            }
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .frame(minHeight: 20)
            Text(entry.text).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                .padding(.top, 3).padding(.bottom, AceTheme.Spacing.xs)
            if let thread {
                Text(thread.title).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1)
            }
        }
        .padding(.top, 11).padding(.bottom, AceTheme.Spacing.md)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// "Snoozed (2) ⌄": a folded group at the end of the list, quiet until opened.
struct InboxShelf: View {
    let label: String
    let count: Int
    let expanded: Bool
    let toggle: () -> Void
    var body: some View {
        Button(action: toggle) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text("\(label) (\(count.formatted()))")
                Spacer(minLength: AceTheme.Spacing.sm)
                Image(systemName: "chevron.down").imageScale(.small)
                    .rotationEffect(.degrees(expanded ? 180 : 0))
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.subtleForeground)
            .frame(minHeight: AceTheme.Dimensions.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    }
}
