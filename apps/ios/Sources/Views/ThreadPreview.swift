import SwiftUI

/// What a long press on a row shows above its menu, as the web's hover card does: the title and
/// the row's own status words, then one fact a line (project, machine, branch, provider and
/// model with running subagents), and the work it holds (pull request, lines changed). Read from
/// the row alone: no history is fetched. Tapping the row stays the way in.
struct ThreadPreview: View {
    let row: ThreadRow
    let machine: MachineMark?
    let project: ProjectMarkLook?

    private var look: RowLook {
        row.look ?? RowLook(level: "quiet", word: row.status.label, tone: row.status.token, muted: true,
                            glyph: nil, since: nil, settled: false, subagents: max(0, row.agents - 1))
    }

    var body: some View {
        let look = look
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.title).aceFont(InboxRowType.title, relativeTo: .callout).fontWeight(AceDesign.Typeface.regular)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(3)
                // The row's icon and what it means (`rowStatusLook`), as the desktop's hover card
                // leads with it; older bridges keep the status word.
                if let meaning = look.meaning, let icon = look.icon {
                    HStack(spacing: AceDesign.Space.tight) {
                        if icon != "none" { RowStatusIcon(kind: icon, tone: look.iconTone ?? "idle", count: look.count) }
                        Text(meaning).foregroundStyle(look.iconTone == "needs-you" ? AceTheme.RowStatus.needsYou
                                                      : look.iconTone == "failed" ? AceTheme.RowStatus.failed
                                                      : AceTheme.Colours.mutedForeground)
                    }
                    .aceFont(InboxRowType.line, relativeTo: .footnote)
                } else {
                    StateLabel(status: row.status).aceFont(InboxRowType.line, relativeTo: .footnote)
                }
            }
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                if !row.project.isEmpty {
                    fact { AceIcon(.folder, size: AceDesign.Size.glyphMeta, relativeTo: .subheadline) } text: { row.project }
                }
                if let machine, !row.machine.isEmpty {
                    fact { AceIcon(machine.glyph, size: AceDesign.Size.glyphMeta, relativeTo: .subheadline) } text: { row.machine }
                }
                if !row.branch.isEmpty {
                    fact { AceIcon(.gitBranch, size: AceDesign.Size.glyphMeta, relativeTo: .subheadline) } text: { row.branch }
                        .monospaced()
                }
                HStack(spacing: AceDesign.Space.related) {
                    ProviderMark(provider: row.provider, size: AceDesign.Size.icon, account: row.account)
                    Text(row.model.isEmpty ? row.provider.capitalized : row.model).lineLimit(1)
                    Spacer(minLength: AceDesign.Space.related)
                    if look.subagents > 0 {
                        HStack(spacing: AceTheme.Spacing.xxs) {
                            AceIcon(.treeStructure, size: AceDesign.Size.glyphMeta, relativeTo: .subheadline)
                            Text(look.subagents.formatted()).monospacedDigit()
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(look.subagents) \(look.subagents == 1 ? "subagent" : "subagents") running")
                    }
                }
            }
            .aceFont(InboxRowType.line, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            if row.pr != nil || row.diff != nil {
                Divider()
                HStack(spacing: AceDesign.Space.row) {
                    if let pr = row.pr {
                        HStack(spacing: AceDesign.Space.tight) {
                            AceIcon(.gitPullRequest, size: AceDesign.Size.glyphMeta, relativeTo: .subheadline)
                            Text("#\(pr.number)").monospacedDigit()
                            Text(pr.state.capitalized)
                        }
                    }
                    if let diff = row.diff {
                        HStack(spacing: AceDesign.Space.tight) {
                            Text("+\(diff.additions)").foregroundStyle(AceTheme.Colours.diffAdd)
                            Text("−\(diff.deletions)").foregroundStyle(AceTheme.Colours.diffDelete)
                        }
                        .monospacedDigit()
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(diff.additions) lines added, \(diff.deletions) lines removed")
                    }
                    Spacer(minLength: AceTheme.Spacing.none)
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

    private func fact<Mark: View>(@ViewBuilder _ mark: () -> Mark, text: () -> String) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            mark().frame(minWidth: AceDesign.Size.lead)
            Text(text()).lineLimit(1).truncationMode(.middle)
        }
    }
}
