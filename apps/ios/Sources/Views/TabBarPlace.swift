import SwiftUI
import UIKit

/// Hides or shows the system tab bar for this window through the tab bar controller itself:
/// hidden while the sidebar carries the tabs, shown over a phone's lists. Hidden only through
/// SwiftUI's toolbar visibility, the bar is laid out shown first; the split view's columns keep
/// the room it took at launch (an empty band over the sidebar, an extra row in the detail
/// column's bar) and never give it back. A window turning compact again shows it here.
struct TabBarPlace: UIViewControllerRepresentable {
    let hidden: Bool
    var animated = false
    /// Changes when something else may lay the tabs out again and show the bar (the window
    /// appearing, a thread opening, the side panel's inspector column opening or closing): the
    /// place is set once more after that settles.
    var relayout = ""
    /// This page's tab is the one showing. The tab bar is one for every tab, so a page of another
    /// tab (a late retry of its own, a thread opened from a notification) never writes it.
    var selected = true

    func makeUIViewController(context: Context) -> Probe { Probe() }
    func updateUIViewController(_ probe: Probe, context: Context) {
        probe.hidden = hidden
        probe.animated = animated
        probe.selected = selected
        probe.apply()
        if probe.relayout != relayout {
            probe.relayout = relayout
            probe.pending?.cancel()
            probe.pending = Task { @MainActor [weak probe] in
                for wait in [150, 450, 1000] {
                    do { try await Task.sleep(for: .milliseconds(wait)) } catch { return }
                    guard let probe, probe.viewIfLoaded?.window != nil else { return }
                    probe.apply()
                }
            }
        }
    }

    static func dismantleUIViewController(_ probe: Probe, coordinator: ()) {
        probe.pending?.cancel()
    }

    final class Probe: UIViewController {
        var pending: Task<Void, Never>?
        var hidden = false
        var animated = false
        var selected = true
        var relayout = ""
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
            guard selected, viewIfLoaded?.window != nil else { return }
            guard let tabs = tabBarController ?? sequence(first: parent, next: { $0?.parent }).compactMap({ $0 as? UITabBarController }).first else { return }
            guard tabs.isTabBarHidden != hidden else { return }
            tabs.setTabBarHidden(hidden, animated: animated)
        }
    }
}
