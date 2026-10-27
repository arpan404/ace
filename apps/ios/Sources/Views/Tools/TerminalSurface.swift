import SwiftUI
import UIKit

/// The emulator's drawing surface in SwiftUI. The canvas listens to its session directly, so
/// output redraws rows without re-running any SwiftUI body.
struct TerminalSurface: UIViewRepresentable {
    let session: TerminalSession
    let fontSize: CGFloat
    let focused: Bool
    let matches: [TerminalMatch]
    let current: TerminalMatch?
    /// Asks to bring `current` into view; bumps each time Next or Previous is pressed.
    let revealToken: Int
    let onFit: (Int, Int) -> Void
    let onTap: () -> Void
    let onScrollKeys: (Bool, Int) -> Void

    func makeUIView(context: Context) -> TerminalCanvasView {
        let view = TerminalCanvasView(frame: .zero)
        view.backgroundColor = UIColor(AceTheme.Colours.background)
        return view
    }

    func updateUIView(_ view: TerminalCanvasView, context: Context) {
        view.onFit = onFit
        view.onTap = onTap
        view.onScrollKeys = onScrollKeys
        view.fontSize = fontSize
        view.session = session
        view.keyboardFocused = focused
        if view.matches != matches { view.matches = matches }
        if view.currentMatch != current { view.currentMatch = current }
        if context.coordinator.revealed != revealToken {
            context.coordinator.revealed = revealToken
            if let current { view.reveal(current) }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var revealed = 0 }
}
