import SwiftUI

/// Just above the capsule, on the field's words' left edge: the files on the next message with
/// their upload progress, then its chips (what it replies to, line comments, drawings) as one row
/// of plain capsules, then the bridge's notice and a pick that couldn't be read. The capsule's own
/// shape never changes for any of them. Every check (size, what the agent can read, which levels
/// exist) is the bridge's; this view draws what the bridge says.
struct ComposerAccessories: View {
    @Bindable var model: ClientModel
    let screen: ThreadScreenModel
    let problem: String?
    /// A pasted file's words, handed back to the message as text; nil offers nothing.
    var asText: ((String) -> Void)? = nil
    private var notice: String? { screen.tune?.notice.isEmpty == false ? screen.tune?.notice : nil }
    /// "Continues in a new thread with your next message": Send does something else now, so it's said.
    private var continues: String? {
        guard screen.controls?.continues == true, let note = screen.controls?.note, !note.isEmpty else { return nil }
        return note
    }
    private var hasChips: Bool { model.sheets.chip != nil || !screen.annotations.isEmpty || !screen.quotes.isEmpty }
    var body: some View {
        if !screen.attachments.isEmpty || hasChips || screen.attachmentsLocked != nil || notice != nil || continues != nil || problem != nil {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                if !screen.attachments.isEmpty {
                    ComposerMediaStrip(files: screen.attachments, remove: { model.detach($0) }, asText: asText)
                }
                if hasChips {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: AceDesign.Space.related) {
                            if !screen.quotes.isEmpty {
                                QuoteChips(items: screen.quotes, remove: { model.removeQuote($0) }, clear: { model.clearQuotes() })
                                    .transition(.opacity)
                            }
                            if let chip = model.sheets.chip {
                                CommentChip(chip: chip) { model.clearComments() }
                                    .transition(.opacity)
                            }
                            if !screen.annotations.isEmpty {
                                AnnotationChips(items: screen.annotations, remove: { model.removeAnnotation($0) }, clear: { model.clearAnnotations() })
                                    .transition(.opacity)
                            }
                        }
                    }
                    .scrollClipDisabled()
                }
                Group {
                    if let locked = screen.attachmentsLocked {
                        Text(locked).foregroundStyle(AceTheme.Colours.mutedForeground)
                            .lineLimit(2).accessibilityIdentifier("composer.attachLocked")
                    }
                    if let continues {
                        Text(continues).foregroundStyle(AceTheme.Colours.mutedForeground)
                            .lineLimit(2).accessibilityIdentifier("composer.continues")
                    }
                    if let notice {
                        Text(notice).foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(2)
                    }
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                ServiceProblem(message: problem)
            }
            // One edge with the field's words: past +, the gap and the field's own inset.
            .padding(.leading, ComposerCapsuleMetrics.aboveInset).padding(.trailing, AceDesign.Space.related)
            .padding(.bottom, AceDesign.Space.tight)
        }
    }
}

/// The thread's model in words, for its title's line: the model's name and its effort and speed
/// in brief. Until the agent reports a model, the provider's name stands in.
@MainActor enum ThreadModelWords {
    static func name(_ screen: ThreadScreenModel) -> String {
        guard let controls = screen.controls else { return "Choose model" }
        if !controls.model.isEmpty { return controls.model }
        if let provider = controls.providerName, !provider.isEmpty { return provider }
        return "Choose model"
    }
    /// "Med", "Med · Fast"; nil when the model has nothing to tune.
    static func tune(_ screen: ThreadScreenModel) -> String? {
        guard let tune = screen.tune else { return nil }
        let effort = tune.efforts.first { $0.id == tune.effort }
        let speed = tune.speeds.first { $0.speed == tune.speed && $0.speed != "standard" }
        return TuneSummary.text(effort: effort.map { $0.short ?? $0.label }, speed: speed?.label,
                                hasLevels: !tune.efforts.isEmpty, hasSpeeds: tune.speeds.count > 1)
    }
    /// The title's model line; a switch not in effect yet (sent from here, queued for the next
    /// turn, or a continuation) carries why.
    static func line(_ screen: ThreadScreenModel) -> ThreadTitleMenu.ModelLine {
        let note = screen.controls?.note.flatMap { $0.isEmpty ? nil : $0 }
        return ThreadTitleMenu.ModelLine(provider: screen.controls?.provider, name: name(screen), tune: tune(screen),
                                         note: note, queued: screen.controls?.switching == "queued" || note != nil)
    }
}
