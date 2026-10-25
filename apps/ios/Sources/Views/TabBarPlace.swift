import SwiftUI
import UIKit

/// Hides the system tab bar for this window while the sidebar carries the tabs, through the tab
/// bar controller itself. Hidden only through SwiftUI's toolbar visibility, the bar is laid out
/// shown first; the split view's columns keep the room it took at launch (an empty band over the
/// sidebar, an extra row in the detail column's bar) and never give it back.
struct TabBarPlace: UIViewControllerRepresentable {
    let hidden: Bool

    func makeUIViewController(context: Context) -> Probe { Probe() }
    func updateUIViewController(_ probe: Probe, context: Context) {
        probe.hidden = hidden
        probe.apply()
    }

    final class Probe: UIViewController {
        var hidden = false
        override func loadView() { view = UIView(); view.isUserInteractionEnabled = false }
        override func didMove(toParent parent: UIViewController?) { super.didMove(toParent: parent); apply() }
        override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); apply() }
        override func viewDidLoad() {
            super.viewDidLoad()
            // A window turning compact or regular lays the tabs out again, showing the bar;
            // the place is set once more after that pass.
            registerForTraitChanges([UITraitHorizontalSizeClass.self]) { (probe: Probe, _: UITraitCollection) in
                Task { @MainActor in probe.apply() }
            }
        }
        override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); apply() }
        func apply() {
            guard let tabs = tabBarController ?? sequence(first: parent, next: { $0?.parent }).compactMap({ $0 as? UITabBarController }).first else { return }
            guard tabs.isTabBarHidden != hidden else { return }
            tabs.setTabBarHidden(hidden, animated: false)
        }
    }
}
