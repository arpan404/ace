import SwiftUI
import UIKit

/// Draws the split view's list column as a plain page column, edge to edge beside the thread
/// with a hairline between them, as the iPhone's own list reads, instead of the system's
/// floating sidebar panel. Set on the split view controller itself, from inside the column.
struct SidebarPlain: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Probe { Probe() }
    func updateUIViewController(_ probe: Probe, context: Context) { probe.apply() }

    final class Probe: UIViewController {
        override func loadView() { view = UIView(); view.isUserInteractionEnabled = false }
        override func didMove(toParent parent: UIViewController?) { super.didMove(toParent: parent); apply() }
        override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); apply() }
        func apply() {
            guard let split = splitViewController, split.primaryBackgroundStyle != .none else { return }
            split.primaryBackgroundStyle = .none
        }
    }
}
