import SwiftUI

extension View {
    /// Esc on a hardware keyboard closes this sheet, from its fields too. The key lives on an
    /// invisible button in the sheet's own content (a toolbar button's shortcut is not reached
    /// from inside the sheet), and the composer's text view hands the key on (`escape`).
    func escapeCloses(_ close: @escaping () -> Void) -> some View {
        background {
            Button("Close", action: close)
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
        .environment(\.escape, close)
    }
}

extension EnvironmentValues {
    /// What Esc does from a text view: closes the sheet around it; nil only drops the keyboard.
    @Entry var escape: (() -> Void)? = nil
}
