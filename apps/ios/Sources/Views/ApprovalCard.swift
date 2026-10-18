import SwiftUI

struct ApprovalCard: View {
    @Environment(\.colorScheme) private var colourScheme
    let approval: ApprovalRow
    let submission: ApprovalSubmission?
    /// False on a view-only pairing: the card still shows the request, without live choices.
    var canAct = true
    let resolve: (ApprovalRow.Option) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            HStack(alignment: .top, spacing: AceTheme.Spacing.md) {
                Image(systemName: "terminal").aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Status.needsYou)
                    .frame(width: AceTheme.Spacing.xxxl, height: AceTheme.Spacing.xxxl).background(AceTheme.Colours.needsYouSurface, in: RoundedRectangle(cornerRadius: AceTheme.Radii.small))
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(nonEmpty(approval.heading) ?? approval.title).aceFont(AceTheme.Typography.title, relativeTo: .headline)
                    let reason = nonEmpty(approval.reason) ?? approval.description
                    if !reason.isEmpty { Text(reason).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
                    if approval.risk == "high", let risk = nonEmpty(approval.riskText) {
                        Text(risk).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.StatusText.failed)
                    }
                }
            }
            if !approval.command.isEmpty {
                Text(approval.command).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(AceTheme.Spacing.md)
                    .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.code))
            }
            if approval.truncated { Text("Some details are shortened for display").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
            Group {
                if approval.verbs.isEmpty { offeredButtons } else { verbButtons }
            }.disabled(submission != nil || !canAct)
            if !canAct { ViewOnlyNote.approval }
            if let submission { Label(submission.phase == .saving ? "Saving your answer…" : "Waiting for the daemon", systemImage: "clock").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
        }
        .padding(AceTheme.Spacing.lg).background(AceTheme.Colours.card, in: RoundedRectangle(cornerRadius: AceTheme.Radii.approval))
        .overlay(RoundedRectangle(cornerRadius: AceTheme.Radii.approval).stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        .shadow(color: AceTheme.Colours.shadow.opacity(AceTheme.Opacity.shadow(colourScheme)), radius: AceTheme.Elevation.floating, y: AceTheme.Elevation.card)
        .padding(.horizontal, AceTheme.Dimensions.composerInset).padding(.bottom, AceTheme.Spacing.sm)
        .sensoryFeedback(.selection, trigger: submission?.requestId)
    }
    /// Deny, Always allow (named by what the grant covers) and Allow once, each the request's own
    /// option; every other offered option waits under More choices.
    private var verbButtons: some View {
        let remaining = approval.remaining
        return HStack(spacing: AceTheme.Spacing.sm) {
            ForEach(approval.verbs) { verb in
                let words = verb.decision.verb == "always_allow" && !verb.decision.scope.isEmpty ? verb.decision.scope : verb.decision.label
                button(words, primary: verb.decision.emphasis == "primary") { resolve(verb.option) }
                    .accessibilityLabel(verb.decision.scope.isEmpty ? verb.decision.label : "\(verb.decision.label): \(verb.decision.scope)")
                    .accessibilityIdentifier("approval.\(verb.option.kind)")
            }
            if !remaining.isEmpty {
                Menu {
                    ForEach(remaining) { other in Button(other.label) { resolve(other.option) } }
                } label: { moreLabel }.accessibilityIdentifier("approval.more")
            }
        }
    }
    /// A row from a daemon that sends no verbs: the offered options as they come.
    private var offeredButtons: some View {
        let options = approval.options.sorted { rank($0.kind) < rank($1.kind) }
        return HStack(spacing: AceTheme.Spacing.sm) {
            ForEach(options.prefix(options.count > 3 ? 2 : options.count)) { option in
                button(option.label, primary: option.kind == "allow_once") { resolve(option) }
                    .accessibilityIdentifier("approval.\(option.kind)")
            }
            if options.count > 3 {
                Menu {
                    ForEach(options.dropFirst(2)) { option in Button(option.label) { resolve(option) } }
                } label: { moreLabel }.accessibilityIdentifier("approval.more")
            }
        }
    }
    private func button(_ words: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(words).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).lineLimit(2).multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
                .foregroundStyle(primary ? AceTheme.Colours.background : AceTheme.Colours.foreground)
                .background(primary ? AceTheme.Colours.foreground : AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.button))
        }.buttonStyle(.plain)
    }
    private var moreLabel: some View {
        Label("More choices", systemImage: "ellipsis")
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
            .foregroundStyle(AceTheme.Colours.foreground)
            .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.button))
    }
    private func nonEmpty(_ value: String?) -> String? { value.flatMap { $0.isEmpty ? nil : $0 } }
    private func rank(_ kind: String) -> Int { kind == "deny" ? 0 : kind == "allow_once" ? 2 : 1 }
}
