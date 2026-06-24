import Foundation
import Inject
import SwiftUI

enum HotReloadSupport {
    @MainActor
    static func configure() {
        #if DEBUG
        _ = InjectConfiguration.load
        let bundlePath = "\(InjectConfiguration.bundlePath)macOSInjection.bundle"
        if FileManager.default.fileExists(atPath: bundlePath) {
            print("AceDesktop hot reload enabled: \(bundlePath)")
        } else {
            print("AceDesktop hot reload unavailable: install InjectionIII.app in /Applications")
        }
        #endif
    }
}
