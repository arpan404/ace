import SwiftUI

/// What the Threads and Pulls lists show while no computer is paired: one line and Add device.
struct NoComputerPaired: View {
    let pair: () -> Void
    var body: some View {
        EmptyState(icon: .laptop, title: "No computer paired",
                   line: "Pair this phone with ace on your computer to see its work here.") {
            Button("Add device", action: pair).accessibilityIdentifier("inbox.empty.pair")
        }
    }
}
