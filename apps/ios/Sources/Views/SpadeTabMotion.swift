import SwiftUI
import UIKit

extension EnvironmentValues {
    @Entry var spadeTabMotion: SpadeTabMotion? = nil
}

/// Update just Spade's item so a frame change never invalidates the SwiftUI TabView.
@MainActor final class SpadeTabMotion {
    private weak var item: UITabBarItem?
    private var owner: ObjectIdentifier?
    private var timer: Task<Void, Never>?
    private var frame = SpadeTabFrame.rest

    func update(owner: ObjectIdentifier, tabs: UITabBarController, enabled: Bool) {
        self.owner = owner
        guard enabled, !tabs.isTabBarHidden, tabs.tabBar.window != nil,
              let item = tabs.tabBar.items?.first(where: { $0.title == HomeTabs.title(.spade) }) else {
            stop(owner: owner)
            return
        }
        if self.item === item, timer != nil { return }

        stop(owner: owner)
        self.owner = owner
        self.item = item
        timer = Task { @MainActor [weak self, weak tabs] in
            let clock = ContinuousClock()
            let start = clock.now
            while !Task.isCancelled {
                guard let self, self.item != nil, let tabs, !tabs.isTabBarHidden, tabs.tabBar.window != nil else {
                    self?.reset()
                    return
                }
                let elapsed = (clock.now - start).components
                let sample = SpadeTabFrame.sample(at: Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18)
                self.show(sample.frame)
                do { try await clock.sleep(until: start.advanced(by: .seconds(sample.next))) }
                catch { return }
            }
        }
    }

    func stop(owner: ObjectIdentifier) {
        guard self.owner == owner else { return }
        reset()
    }

    private func reset() {
        owner = nil
        timer?.cancel()
        timer = nil
        show(.rest)
        item = nil
    }

    private func show(_ frame: SpadeTabFrame) {
        guard self.frame != frame else { return }
        self.frame = frame
        let image = UIImage(named: HomeTabs.tabImage(.spade, spadeFrame: frame))?.withRenderingMode(.alwaysOriginal)
        item?.image = image
        item?.selectedImage = image
    }
}
