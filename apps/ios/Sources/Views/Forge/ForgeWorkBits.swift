import SwiftUI

/// A page action in words (DESIGN.md: words, not chrome): no icon, a 44pt target, red when it
/// undoes work. A disabled one says why underneath.
struct ForgeTextAction: View {
    let label: String
    var destructive = false
    var reason: String?
    var busy = false
    let identifier: String
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Button(action: action) {
                HStack(spacing: AceTheme.Spacing.sm) {
                    Text(label).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    if busy { ProgressView().controlSize(.small).transition(.opacity) }
                }
                .foregroundStyle(destructive ? AceTone.failed.text : AceTheme.Colours.foreground)
                .frame(minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .disabled(reason != nil || busy)
            .accessibilityIdentifier(identifier)
            if let reason { Text(reason).meta() }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, AceTheme.Spacing.lg)
        .animation(AceMotion.smooth, value: busy)
    }
}

/// What the last write from a page did: quiet when done, red when refused, and an answer that
/// never came says so (the page reads GitHub again rather than assuming).
struct ForgeOutcomeLine: View {
    let outcome: ForgeWorkOutcome?
    let identifier: String

    var body: some View {
        Group {
            if let outcome, !outcome.message.isEmpty || outcome.uncertain {
                Text(text(outcome))
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(outcome.ok ? AceTheme.Colours.mutedForeground : AceTone.failed.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, AceTheme.Spacing.lg)
                    .transition(.opacity)
                    .accessibilityIdentifier(identifier)
            }
        }
        .animation(AceMotion.smooth, value: outcome)
    }

    private func text(_ outcome: ForgeWorkOutcome) -> String {
        guard outcome.uncertain else { return outcome.message }
        return "\(outcome.message.isEmpty ? "Not confirmed." : outcome.message) Pull down to read GitHub again before trying again."
    }
}

/// A linked thread to run a change through, when there is more than one to choose from.
struct ForgeThreadPicker: View {
    let threads: [ForgeThreadChoice]
    let chosen: String?
    let pick: (String) -> Void

    var body: some View {
        if threads.count > 1 {
            HStack {
                Text("Thread").aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                    .foregroundStyle(AceTheme.Colours.foreground)
                Spacer(minLength: AceTheme.Spacing.sm)
                Menu {
                    Picker("Thread", selection: Binding(get: { chosen ?? "" }, set: pick)) {
                        ForEach(threads, id: \.id) { Text($0.title).tag($0.id) }
                    }
                } label: { Text(threads.first { $0.id == chosen }?.title ?? "Choose").meta().lineLimit(1) }
                    .accessibilityIdentifier("forge.work.thread")
            }
            .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 44)
        }
    }
}

extension ClientModel {
    /// Puts `request` in thread `threadId`'s composer, after any words already there, for the
    /// person to read over and send; nothing is sent on their behalf.
    func handOff(_ request: String, to threadId: String, drafts: ThreadDrafts?) -> Bool {
        guard let drafts, let hostId else { return false }
        let key = ThreadDrafts.key(hostId: hostId, threadId: threadId)
        let before = drafts.text(for: key)
        // Words are added after what is there, so the references picked into it keep their places.
        drafts.save(before.isEmpty ? request : "\(before)\n\n\(request)", picks: drafts.picks(for: key), for: key)
        return true
    }
}

/// A word that acts inside a row ("Check out", "Run checks", "Ours"): no chrome, but the whole
/// 44-point height takes the tap, and it dims while pressed or unavailable.
struct ForgeWordButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { WordLabel(configuration: configuration) }
    private struct WordLabel: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var enabled
        var body: some View {
            configuration.label
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
                .contentShape(Rectangle())
                .opacity(!enabled ? 0.45 : configuration.isPressed ? 0.6 : 1)
                .animation(.smooth(duration: 0.15), value: configuration.isPressed)
        }
    }
}

extension ButtonStyle where Self == ForgeWordButtonStyle {
    static var forgeWord: ForgeWordButtonStyle { ForgeWordButtonStyle() }
}

/// The forge and Work pages' state changes: the system's smooth spring, or under Reduce Motion
/// a short ease with no overshoot, so things fade in place rather than travel.
enum AceMotion {
    @MainActor static var smooth: Animation {
        UIAccessibility.isReduceMotionEnabled ? .easeInOut(duration: 0.2) : .smooth
    }
}
