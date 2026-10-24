import SwiftUI

/// "1m 14s": time since a moment the bridge gave in ms since 1970, as the web counts it.
enum Elapsed {
    static func words(since: Double, now: Date) -> String {
        let seconds = max(1, Int(now.timeIntervalSince1970 - since / 1000))
        return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow))
    }
}

/// The `--border` hairline under a line.
struct Hairline: View {
    var body: some View {
        Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
            .accessibilityHidden(true)
    }
}
