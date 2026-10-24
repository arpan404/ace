import SwiftUI

/// One thread in the inbox (DESIGN.md §3 list row): project … status, the title, then branch ·
/// pull request … machine · subagents · provider. How loud it reads comes from the bridge's
/// `look` (the web's `rowAttention`): only what needs the person takes colour; live work keeps a
/// small glyph and its elapsed time in muted ink; a row at rest shows only its age.
struct InboxThreadRow: View {
    let row: ThreadRow
    let snoozed: Bool
    var machine: String? = nil
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Old payloads without a look read quietly with the shared word.
    private var look: RowLook {
        row.look ?? RowLook(level: "quiet", word: row.status.label, tone: row.status.token, muted: true,
                            glyph: nil, since: nil, settled: false, subagents: max(0, row.agents - 1))
    }
    private var titleInk: Color {
        look.level == "needs-you" || look.level == "failed" || !look.muted
            ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground
    }

    var body: some View {
        let look = look
        // At accessibility text sizes the side-by-side lines stack, so nothing is cut off.
        let stacked = typeSize.isAccessibilitySize
        let line = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceTheme.Spacing.xxs))
                           : AnyLayout(HStackLayout(spacing: AceTheme.Spacing.sm))
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            line {
                project(quiet: look.muted)
                if !stacked { Spacer(minLength: AceTheme.Spacing.sm) }
                InboxRowStatus(row: row, look: look, snoozed: snoozed)
            }
            Text(row.title)
                .aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                .foregroundStyle(titleInk)
                .lineLimit(stacked ? nil : 1)
            line {
                context
                if !stacked { Spacer(minLength: AceTheme.Spacing.sm) }
                trailing(look)
            }
            .foregroundStyle(AceTheme.Colours.subtleForeground)
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func project(quiet: Bool) -> some View {
        if !row.project.isEmpty {
            HStack(spacing: AceTheme.Spacing.sm) {
                ProjectTag(initials: row.badge ?? String(row.project.prefix(2)), quiet: quiet, chat: row.chat == true)
                Text(row.project).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).lineLimit(1)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
    }
    /// Branch (mono) and pull request lead the last line.
    @ViewBuilder private var context: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if !row.branch.isEmpty {
                Text(row.branch).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                    .lineLimit(1).truncationMode(.middle)
            }
            if let pr = row.pr { InboxPullRequest(pr: pr) }
        }
    }
    /// The machine when several are paired, running subagents, then the provider.
    private func trailing(_ look: RowLook) -> some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if let machine, !machine.isEmpty {
                Text(machine).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).lineLimit(1)
            }
            if look.subagents > 0 {
                HStack(spacing: AceTheme.Spacing.xxs) {
                    AceIcon(.treeStructure, size: 13, relativeTo: .footnote)
                    Text(look.subagents.formatted()).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).monospacedDigit()
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(look.subagents) subagents running")
            }
            ProviderMark(provider: row.provider, account: row.account, quiet: look.muted)
        }
    }
}

/// The first line's status, as loud as the row's look: a word with its glyph and, for live
/// work, how long it has run; a snoozed row says when it wakes; a row at rest shows its age.
struct InboxRowStatus: View {
    let row: ThreadRow
    let look: RowLook
    let snoozed: Bool

    var body: some View {
        TimelineView(.everyMinute) { context in
            // On the Snoozed shelf a row says when it wakes, unless it asks for the person.
            if snoozed, !look.loud, let until = row.snoozedUntil {
                HStack(spacing: AceTheme.Spacing.xs) {
                    AceIcon(.clock, size: 13, relativeTo: .footnote)
                    Text(Self.wake(until))
                }
                .meta()
            } else if let word = look.word {
                StatusLabel(word: word, tone: AceTone(look.tone), glyph: look.glyph.flatMap(GlyphState.init(rawValue:)),
                            loud: look.loud, elapsed: look.level == "active" ? elapsed(at: context.date) : nil)
            } else {
                Text(age(at: context.date)).monospacedDigit().meta()
            }
        }
    }

    /// Native date formatting of the bridge's timestamps; no state is derived here.
    private func elapsed(at now: Date) -> String? {
        guard let start = look.since ?? row.activityAt else { return nil }
        return ActivityTime.elapsed(since: Date(timeIntervalSince1970: start / 1000), now: now)
    }
    private func age(at now: Date) -> String {
        ActivityTime.age(since: Date(timeIntervalSince1970: (row.activityAt ?? row.updatedAt) / 1000), now: now)
    }
    static func wake(_ until: Double) -> String {
        let date = Date(timeIntervalSince1970: until / 1000)
        let time = date.formatted(date: .omitted, time: .shortened)
        return Calendar.current.isDateInToday(date) ? "Until \(time)" : "Until \(date.formatted(.dateTime.weekday(.abbreviated))) \(time)"
    }
}

/// A settled thread at rest, one quiet line: its grey tag and title, then what the work left
/// behind (the pull request, else the lines changed) and its age.
struct InboxSettledRow: View {
    let row: ThreadRow

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            ProjectTag(initials: row.badge ?? String(row.project.prefix(2)), quiet: true, chat: row.chat == true)
            Text(row.title)
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .lineLimit(1)
            Spacer(minLength: AceTheme.Spacing.sm)
            Group {
                if let pr = row.pr { InboxPullRequest(pr: pr) }
                else if let diff = row.diff, diff.additions + diff.deletions > 0 {
                    Text("+\(diff.additions) −\(diff.deletions)").monospacedDigit()
                }
                TimelineView(.everyMinute) { context in
                    Text(ActivityTime.age(since: Date(timeIntervalSince1970: (row.activityAt ?? row.updatedAt) / 1000), now: context.date))
                        .monospacedDigit()
                }
            }
            .meta(AceTheme.Colours.faintForeground)
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// "#188" after the pull request glyph; merged requests take the merge glyph.
struct InboxPullRequest: View {
    let pr: PullRequestRef
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xxs) {
            AceIcon(pr.state == "merged" ? .gitMerge : .gitPullRequest, size: 13, relativeTo: .footnote)
            Text("#\(pr.number)").monospacedDigit()
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(pr.state.capitalized) pull request \(pr.number)")
    }
}

/// A send the SDK still holds, drawn like a thread row: project … the shared unsent wording,
/// the text, then the thread it goes to.
struct InboxUnsentRow: View {
    let entry: PendingRow
    let thread: ThreadRow?
    var body: some View {
        let tone = AceTone(entry.token ?? "neutral")
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(spacing: AceTheme.Spacing.sm) {
                if let thread, !thread.project.isEmpty {
                    ProjectTag(initials: thread.badge ?? String(thread.project.prefix(2)), chat: thread.chat == true)
                    Text(thread.project).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).lineLimit(1)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                Spacer(minLength: AceTheme.Spacing.sm)
                StatusLabel(word: entry.label ?? "", tone: tone, glyph: tone == .needsYou ? .needsYou : nil, loud: tone == .needsYou)
            }
            Text(entry.text).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
            if let thread {
                Text(thread.title).meta(AceTheme.Colours.subtleForeground).lineLimit(1)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// "Snoozed 2 ›": a folded group at the end of the list, quiet until opened.
struct InboxShelf: View {
    let label: String
    let count: Int
    let expanded: Bool
    let toggle: () -> Void
    var body: some View {
        Button(action: toggle) {
            HStack(spacing: AceTheme.Spacing.xs) {
                Text(label).fontWeight(.medium)
                Text(count.formatted()).monospacedDigit().foregroundStyle(AceTheme.Colours.subtleForeground)
                AceIcon(.caretRight, size: 12, weight: .bold, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.faintForeground)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.md)
            .frame(minHeight: 40)
        }
        .buttonStyle(.row)
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    }
}

extension View {
    /// Row metadata (`text-meta`): caption size in the given tier, muted by default.
    func meta(_ ink: Color = AceTheme.Colours.mutedForeground) -> some View {
        aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(ink).lineLimit(1)
    }
}
