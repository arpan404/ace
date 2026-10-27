import SwiftUI

/// A pull request or issue page pushed on the second tab's stack (`InboxRoute.forge`).
struct ForgeRoute: Hashable {
    /// A pull request or issue page, a pull request's Timeline, or one of its changed files.
    enum Kind: String { case pull, issue, timeline, files, file }
    let kind: Kind
    let machineId: String
    let project: String
    let number: Int
    /// The changed file a `file` page shows, and where it sits in the pull request's list.
    var path: String?
    var index: Int?
    /// Another repository than the project's own (a notification's), named in every read.
    var repository: ForgeRepository?
}

/// One pull request (the web's list row, laid out for the phone): glyph, number, labels and its
/// review, checks and comments; the title; then author, branches and thread, and on the right
/// its next step (only the viewer's steps take the needs-you colour) or what it waits on, and
/// its age.
struct ForgePullRowView: View {
    let row: ForgePullRow

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(spacing: AceTheme.Spacing.sm) {
                ForgePullGlyph(state: row.state, merged: row.merged, conflicting: row.conflicting, size: 15)
                Text(verbatim: "#\(row.number)").aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                ForgeLabels(labels: row.labels, limit: 2)
                Spacer(minLength: AceTheme.Spacing.sm)
                if let review = row.review { ForgeStateMark(kind: .review, mark: review) }
                if let checks = row.checks { ForgeStateMark(kind: .checks, mark: checks) }
                ForgeComments(count: row.comments)
                if let additions = row.additions, let deletions = row.deletions {
                    ForgeDiffStat(additions: additions, deletions: deletions)
                }
            }
            Text(row.title)
                .aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                .openRowTitle()
                .foregroundStyle(AceTheme.Colours.foreground)
                .lineLimit(2)
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(row.author).lineLimit(1)
                if let branches = row.branches {
                    Text(branches).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                        .lineLimit(1)
                        .layoutPriority(-1)
                }
                if let thread = row.thread { ForgeThreadChip(thread: thread) }
                Spacer(minLength: AceTheme.Spacing.sm)
                ForgeRowStep(step: row.step, needsYou: row.stepNeedsYou, quiet: row.quiet, updatedAt: row.updatedAt)
            }
            .meta(AceTheme.Colours.subtleForeground)
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// One issue: glyph, number, labels, comments and assignees; the title; then author, milestone
/// and thread, and its age.
struct ForgeIssueRowView: View {
    let row: ForgeIssueRow

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(spacing: AceTheme.Spacing.sm) {
                ForgeIssueGlyph(state: row.state, size: 15)
                Text(verbatim: "#\(row.number)").aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                ForgeLabels(labels: row.labels, limit: 2)
                Spacer(minLength: AceTheme.Spacing.sm)
                ForgeComments(count: row.comments)
                if !row.assignees.isEmpty {
                    HStack(spacing: AceTheme.Spacing.xxs) {
                        AceIcon(.user, size: 13, relativeTo: .footnote)
                        Text(row.assignees.count == 1 ? row.assignees[0] : row.assignees.count.formatted()).lineLimit(1)
                    }
                    .meta(AceTheme.Colours.subtleForeground)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Assigned to \(row.assignees.joined(separator: ", "))")
                }
            }
            Text(row.title)
                .aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                .openRowTitle()
                .foregroundStyle(AceTheme.Colours.foreground)
                .lineLimit(2)
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(row.author).lineLimit(1)
                if let milestone = row.milestone { Text(milestone).lineLimit(1) }
                if let thread = row.thread { ForgeThreadChip(thread: thread) }
                Spacer(minLength: AceTheme.Spacing.sm)
                ForgeRowStep(step: nil, needsYou: false, quiet: nil, updatedAt: row.updatedAt)
            }
            .meta(AceTheme.Colours.subtleForeground)
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The thread working on it, by name; a thread waiting on the person says so in its colour.
struct ForgeThreadChip: View {
    let thread: ForgeThreadLink
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xxs) {
            AceIcon(.chats, size: 12, relativeTo: .footnote)
            Text(thread.title).lineLimit(1)
        }
        .foregroundStyle(thread.needsYou ? AceTone.needsYou.text : AceTheme.Colours.subtleForeground)
        .layoutPriority(-2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(thread.needsYou ? "Thread \(thread.title), needs you" : "Thread \(thread.title)")
    }
}

struct ForgeComments: View {
    let count: Int
    var body: some View {
        if count > 0 {
            HStack(spacing: AceTheme.Spacing.xxs) {
                AceIcon(.chatCircle, size: 13, relativeTo: .footnote)
                Text(count.formatted()).monospacedDigit()
            }
            .meta(AceTheme.Colours.subtleForeground)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(count) comments")
        }
    }
}

/// The row's trailing words: its step (the viewer's in the needs-you colour, others in muted
/// ink), or what it waits on, then its age.
struct ForgeRowStep: View {
    let step: String?
    let needsYou: Bool
    let quiet: String?
    let updatedAt: Double?

    var body: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            if let step {
                Text(step).fontWeight(.medium)
                    .foregroundStyle(needsYou ? AceTone.needsYou.text : AceTheme.Colours.mutedForeground)
                    .lineLimit(1)
            } else if let quiet {
                Text(quiet).lineLimit(1)
            }
            if let updatedAt {
                TimelineView(.everyMinute) { context in
                    Text(ActivityTime.age(since: Date(timeIntervalSince1970: updatedAt / 1000), now: context.date))
                        .monospacedDigit()
                }
            }
        }
        .fixedSize()
    }
}
