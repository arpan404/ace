import SwiftUI

/// A page action that is a row of its section (ADR 0184): its words in the action colour at the
/// row's height, red when it undoes work, a spinner while it runs. A disabled one says why
/// underneath.
struct ForgeTextAction: View {
    let label: String
    var destructive = false
    var reason: String?
    var busy = false
    let identifier: String
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Button(role: destructive ? .destructive : nil, action: action) {
                HStack(spacing: AceDesign.Space.related) {
                    Text(label)
                    if busy { ProgressView().controlSize(.small).transition(.opacity) }
                }
            }
            .buttonStyle(.rowAction)
            .disabled(reason != nil || busy)
            .accessibilityIdentifier(identifier)
            if let reason { Text(reason).meta().padding(.bottom, AceDesign.Space.tight) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, AceDesign.Space.margin)
        .animation(.default, value: busy)
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
        .animation(.default, value: outcome)
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
                    Picker("Thread", selection: Binding(get: { chosen ?? "" }, set: { value in pick(value) })) {
                        ForEach(threads, id: \.id) { Text($0.title).tag($0.id) }
                    }
                } label: { Text(threads.first { $0.id == chosen }?.title ?? "Choose").meta().lineLimit(1) }
                    .accessibilityIdentifier("forge.work.thread")
            }
            .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: AceDesign.Size.tap)
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
