import SwiftUI

struct ApprovalCard: View {
    @Environment(\.colorScheme) private var colourScheme
    let approval: ApprovalRow
    let submission: ApprovalSubmission?
    let resolve: (ApprovalRow.Option) -> Void
    var body: some View {
        let options = approval.options.sorted { rank($0.kind) < rank($1.kind) }
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            HStack(alignment: .top, spacing: AceTheme.Spacing.md) {
                Image(systemName: "terminal").aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Status.needsYou)
                    .frame(width: AceTheme.Spacing.xxxl, height: AceTheme.Spacing.xxxl).background(AceTheme.Colours.needsYouSurface, in: RoundedRectangle(cornerRadius: AceTheme.Radii.small))
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(approval.title).aceFont(AceTheme.Typography.title, relativeTo: .headline)
                    if !approval.description.isEmpty { Text(approval.description).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
                }
            }
            if !approval.command.isEmpty {
                Text(approval.command).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(AceTheme.Spacing.md)
                    .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.code))
            }
            if approval.truncated { Text("Some details are shortened for display").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
            HStack(spacing: AceTheme.Spacing.sm) {
                ForEach(options.prefix(options.count > 3 ? 2 : options.count)) { option in
                    Button {
                        resolve(option)
                    } label: {
                        Text(option.label).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
                            .foregroundStyle(option.kind == "allow_once" ? AceTheme.Colours.background : AceTheme.Colours.foreground)
                            .background(option.kind == "allow_once" ? AceTheme.Colours.foreground : AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.button))
                    }.buttonStyle(.plain).accessibilityIdentifier("approval.\(option.kind)")
                }
                if options.count > 3 {
                    Menu {
                        ForEach(options.dropFirst(2)) { option in Button(option.label) { resolve(option) } }
                    } label: {
                        Label("More choices", systemImage: "ellipsis")
                            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                            .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
                            .foregroundStyle(AceTheme.Colours.foreground)
                            .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.button))
                    }.accessibilityIdentifier("approval.more")
                }
            }.disabled(submission != nil)
            if let submission { Label(submission.phase == .saving ? "Saving your answer…" : "Waiting for the daemon", systemImage: "clock").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
        }
        .padding(AceTheme.Spacing.lg).background(AceTheme.Colours.card, in: RoundedRectangle(cornerRadius: AceTheme.Radii.approval))
        .overlay(RoundedRectangle(cornerRadius: AceTheme.Radii.approval).stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        .shadow(color: AceTheme.Colours.shadow.opacity(AceTheme.Opacity.shadow(colourScheme)), radius: AceTheme.Elevation.floating, y: AceTheme.Elevation.card)
        .padding(.horizontal, AceTheme.Dimensions.composerInset).padding(.bottom, AceTheme.Spacing.sm)
        .sensoryFeedback(.selection, trigger: submission?.requestId)
    }
    private func rank(_ kind: String) -> Int { kind == "deny" ? 0 : kind == "allow_once" ? 2 : 1 }
}
