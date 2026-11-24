import SwiftUI

/// What a long press on a row shows above its menu, as the desktop's hover card does: the title,
/// the status sentence with what it is about and what an agent drives, then one fact a line
/// (project with its mark, machine, branch, the account and model with running subagents), and
/// the work it holds (each linked pull request with its repository and title, lines changed).
/// Read from the row alone: no history is fetched. Tapping the row stays the way in.
struct ThreadPreview: View {
    /// The long-press preview is where a row's cut title and detail are read whole.
    static let readLines = 8
    let row: ThreadRow
    let machine: MachineMark?
    let project: ProjectMarkLook?

    private var look: RowLook { InboxThreadRow.look(of: row) }
    private var hover: ThreadRow.HoverLine? { Self.hover(of: row) }
    /// The hover card's line, only from a confirmed row: an unconfirmed copy's says what was true
    /// then, so the preview reads Syncing like its row.
    static func hover(of row: ThreadRow) -> ThreadRow.HoverLine? { row.confirmed == true ? row.hover : nil }

    var body: some View {
        let look = look
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.title).aceFont(InboxRowType.title, relativeTo: .callout).fontWeight(AceDesign.Typeface.strong)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(Self.readLines)
                status(look)
                ForEach([row.browsing, row.computerUse].compactMap { $0 }, id: \.self) { use in
                    HStack(spacing: AceDesign.Space.tight) {
                        if use == row.browsing {
                            BrowserUseMark(size: AceDesign.Size.glyphMeta).foregroundStyle(AceDesign.Status.working)
                        } else {
                            PebbleMark(size: AceDesign.Size.glyphMeta)
                        }
                        Text(use).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    .aceFont(InboxRowType.line, relativeTo: .footnote)
                }
            }
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                if !row.project.isEmpty {
                    fact { ProjectMark(initials: "", chat: row.chat == true, look: project) } text: { row.project }
                }
                if let machine {
                    fact { AceIcon(machine.glyph, size: AceDesign.Size.glyphMeta, relativeTo: .footnote) } text: { machine.name }
                }
                if !row.branch.isEmpty {
                    fact { AceIcon(.gitBranch, size: AceDesign.Size.glyphMeta, relativeTo: .footnote) } text: { row.branch }
                        .monospaced()
                }
                HStack(spacing: AceDesign.Space.related) {
                    ProviderMark(provider: row.provider, size: AceDesign.Size.glyphMeta, account: row.account)
                        .frame(minWidth: AceDesign.Size.lead)
                    // The account and the model; the mark already names the provider.
                    Text(accountLine).lineLimit(1)
                    Spacer(minLength: AceDesign.Space.related)
                    if look.subagents > 0 {
                        HStack(spacing: AceTheme.Spacing.xxs) {
                            AceIcon(.treeStructure, size: AceDesign.Size.glyphMeta, relativeTo: .footnote)
                            Text(look.subagents.formatted()).monospacedDigit()
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(look.subagents) \(look.subagents == 1 ? "subagent" : "subagents") running")
                    }
                }
            }
            .aceFont(InboxRowType.line, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            if row.pr != nil || row.work != nil {
                Divider()
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    ForEach(pulls, id: \.number) { pr in
                        HStack(spacing: AceDesign.Space.related) {
                            AceIcon(pr.state == "merged" ? .gitMerge : .gitPullRequest, size: AceDesign.Size.glyphMeta, relativeTo: .footnote)
                                .frame(minWidth: AceDesign.Size.lead)
                            Text(verbatim: "#\(pr.number)").monospacedDigit().foregroundStyle(AceTheme.Colours.subtleForeground)
                            Text(pr.title ?? pr.repo).lineLimit(1)
                        }
                        .accessibilityElement(children: .combine)
                    }
                    // Several repositories: each pull request says which.
                    if Set(pulls.map(\.repo)).count > 1 {
                        Text(Set(pulls.map(\.repo)).sorted().joined(separator: ", "))
                            .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1)
                    } else if let repo = pulls.first?.repo {
                        Text(repo).foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1)
                    }
                    if let work = row.work { InboxRowWork(work: work) }
                }
                .aceFont(InboxRowType.line, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
        .padding(AceDesign.Space.margin)
        .frame(width: AceDesign.Size.popover, alignment: .leading)
        .background(AceTheme.Colours.background)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("thread.preview")
    }

    /// "Work · gpt-5.5", or the provider's name where neither is known.
    private var accountLine: String {
        let parts = [row.accountLabel, row.model.isEmpty ? nil : row.model].compactMap { $0 }
        return parts.isEmpty ? row.provider.capitalized : parts.joined(separator: " · ")
    }
    /// Every linked pull request, or the card's one where the row lists none.
    private var pulls: [ThreadRow.LinkedPull] {
        if let prs = row.prs, !prs.isEmpty { return prs }
        return row.pr.map { [ThreadRow.LinkedPull(number: $0.number, state: $0.state, repo: "", title: nil)] } ?? []
    }

    /// The hover card's sentence with the row's own icon, coloured only when it needs the person
    /// or just failed; what it is about under it. Older bridges keep the row's meaning.
    @ViewBuilder private func status(_ look: RowLook) -> some View {
        let sentence = hover?.sentence ?? look.meaning
        if let sentence {
            HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.tight) {
                if let icon = look.icon, icon != "none" { RowStatusIcon(kind: icon, tone: look.iconTone ?? "idle", count: look.count) }
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(sentence).foregroundStyle(ink)
                    if let detail = hover?.detail {
                        Text(detail).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(Self.readLines)
                            .monospaced(hover?.code == true)
                    }
                }
            }
            .aceFont(InboxRowType.line, relativeTo: .footnote)
        } else {
            StateLabel(status: row.status).aceFont(InboxRowType.line, relativeTo: .footnote)
        }
    }
    private var ink: Color {
        switch hover?.ink ?? (look.iconTone == "needs-you" ? "warning" : look.iconTone == "failed" ? "destructive" : "muted") {
        case "warning": AceTheme.RowStatus.needsYou
        case "destructive": AceTheme.RowStatus.failed
        default: AceTheme.Colours.mutedForeground
        }
    }

    private func fact<Mark: View>(@ViewBuilder _ mark: () -> Mark, text: () -> String) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            mark().frame(minWidth: AceDesign.Size.lead)
            Text(text()).lineLimit(1).truncationMode(.middle)
        }
    }
}
