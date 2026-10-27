import SwiftUI

/// Inside the composer, above the message, while it writes a fork: where the fork starts and
/// Cancel, which goes back to writing to this thread. Sending starts the fork and opens it.
struct ForkStrip: View {
    let fork: ForkDraftRow
    let cancel: () -> Void
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            (Text(fork.sending ? "Starting the fork from " : "Forking from ")
                + Text(fork.from).foregroundStyle(AceTheme.Colours.foreground))
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("composer.fork")
            if !fork.sending {
                Button("Cancel", action: cancel)
                    .buttonStyle(StripTextButtonStyle())
                    .accessibilityLabel("Cancel the fork")
                    .accessibilityIdentifier("composer.fork.cancel")
            }
        }
        .padding(.leading, AceTheme.Spacing.lg).padding(.trailing, AceTheme.Spacing.xs)
        .padding(.top, AceTheme.Spacing.xs)
    }
}

/// The strip takes the place of the Fork or Edit button that opened it, so the move reads as one.
struct ForkDestination: ViewModifier {
    let namespace: Namespace.ID
    let rowId: String?
    func body(content: Content) -> some View {
        if let rowId {
            content.matchedGeometryEffect(id: "fork.\(rowId)", in: namespace, properties: .position, isSource: false)
        } else {
            content
        }
    }
}
