import SwiftUI

/// A machine screen's connection: quiet while connecting, a retry when it can't reach. (The
/// inbox itself says this in its title; see `InboxTitle`.)
struct InboxConnectionBanner: View {
    let connection: String
    let retry: () -> Void
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if waiting { ProgressView().controlSize(.mini) } else { AceIcon(.wifiSlash, size: 14, relativeTo: .caption) }
            Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            Spacer(minLength: AceTheme.Spacing.sm)
            if !waiting { Button("Retry", action: retry).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).buttonStyle(.borderless) }
        }
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("inbox.connection")
    }
    private var waiting: Bool { connection == "connecting" || connection == "starting" }
    private var message: String {
        switch connection {
        case "fatal": "Connection needs attention"
        case "offline", "reconnecting": "Offline · showing what this phone last saw"
        default: "Connecting to your machine…"
        }
    }
}
