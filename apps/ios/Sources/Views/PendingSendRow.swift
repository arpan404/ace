import SwiftUI

/// A message the phone holds that hasn't reached the transcript yet, from the SDK's state: the
/// bubble as it will read, then how its sending goes, as the web words it: "Sending…" (or the
/// shared unsent wording, such as "Sends on reconnect"), or "Not sent" with Retry.
struct PendingSendRow: View {
    let row: PendingRow
    let canRetry: Bool
    let retry: () async -> Bool
    @State private var retrying = false
    var body: some View {
        VStack(alignment: .trailing, spacing: AceTheme.Spacing.xs) {
            UserBubble(text: row.text, id: row.id)
            HStack(spacing: AceTheme.Spacing.xs) {
                if row.state == "failed" {
                    AceIcon(.warning, size: 12, relativeTo: .caption)
                    Text("Not sent").fontWeight(.medium)
                    if canRetry {
                        Button {
                            retrying = true
                            Task { _ = await retry(); retrying = false }
                        } label: {
                            Label { Text("Retry") } icon: { AceIcon(.arrowClockwise, size: 12, relativeTo: .caption) }
                                .labelStyle(.titleAndIcon)
                                .padding(.horizontal, AceTheme.Spacing.sm)
                                .frame(minHeight: AceTheme.Spacing.xxxl)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .fontWeight(.medium).foregroundStyle(AceTheme.Colours.mutedForeground)
                        .disabled(retrying)
                        .accessibilityIdentifier("pending.retry")
                    }
                    if row.fenced == true { ClearStaleLockWord() }
                } else {
                    AceIcon(.clock, size: 12, relativeTo: .caption)
                    Text(row.label ?? "Sending…")
                }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
            .foregroundStyle(row.state == "failed" ? AceTheme.StatusText.failed : AceTheme.Colours.subtleForeground)
            .accessibilityElement(children: .contain)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
