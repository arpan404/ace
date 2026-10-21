import SwiftUI

/// A message the phone holds that hasn't reached the transcript yet, from the SDK's state: the
/// bubble as it will read, then "Sending…" or, when it failed, "Not sent" with Try again.
struct PendingSendRow: View {
    let row: PendingRow
    let canRetry: Bool
    let retry: () async -> Bool
    @State private var retrying = false
    var body: some View {
        VStack(alignment: .trailing, spacing: AceTheme.Spacing.xs) {
            UserBubble(text: row.text)
            HStack(spacing: AceTheme.Spacing.xs) {
                if row.state == "failed" {
                    Text("Not sent").foregroundStyle(AceTheme.StatusText.failed)
                    if canRetry {
                        Text(verbatim: "·").foregroundStyle(AceTheme.Colours.subtleForeground)
                        Button("Try again") {
                            retrying = true
                            Task { _ = await retry(); retrying = false }
                        }
                        .fontWeight(.semibold).foregroundStyle(AceTheme.Colours.foreground)
                        .disabled(retrying)
                        .accessibilityIdentifier("pending.retry")
                    }
                } else {
                    Text("Sending…").foregroundStyle(AceTheme.Colours.subtleForeground)
                }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
