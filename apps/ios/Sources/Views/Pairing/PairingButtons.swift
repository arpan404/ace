import SwiftUI

/// The pairing pages' buttons, as real controls rather than words: the one way forward is a
/// prominent glass capsule in the accent, the others plain glass capsules. Before iOS 26, the
/// bordered equivalents. Local until the shared styles of ADR 0184 (#2268) merge; then each
/// becomes `.buttonStyle(.primaryAction)` or `.buttonStyle(.secondaryAction)` with the same
/// capsule and size, and this file goes.
extension View {
    @ViewBuilder func pairingPrimaryButton() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glassProminent).buttonBorderShape(.capsule).controlSize(.large)
                .tint(AceTheme.Colours.accent).foregroundStyle(AceTheme.Colours.onAccent)
        } else {
            buttonStyle(.borderedProminent).buttonBorderShape(.capsule).controlSize(.large)
                .tint(AceTheme.Colours.accent).foregroundStyle(AceTheme.Colours.onAccent)
        }
    }

    @ViewBuilder func pairingSecondaryButton(_ size: ControlSize = .large) -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glass).buttonBorderShape(.capsule).controlSize(size).tint(AceDesign.Ink.primary)
        } else {
            buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(size).tint(AceDesign.Ink.primary)
        }
    }
}
