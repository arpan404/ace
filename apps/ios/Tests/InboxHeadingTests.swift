import Testing
import SwiftUI
import UIKit
@testable import Ace

@MainActor @Suite struct InboxHeadingTests {
    @Test func aLongScopeAndReconnectingMachineStayWithinTheHeaderWidth() async throws {
        let heading = InboxHeading<EmptyView>(
            title: "Threads", scope: "All machines · All projects",
            problem: InboxConnectionProblem(text: "Reconnecting to Arpan's MacBook Pro", trying: true, identifier: "inbox.connection"),
            openMachines: {}, choices: { Optional<EmptyView>.none })
        let host = UIHostingController(rootView: heading)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 220, height: 100))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .seconds(1))
        for width: CGFloat in [160, 220, 320] {
            let size = host.sizeThatFits(in: CGSize(width: width, height: 100))
            #expect(size.width <= width, "The reconnecting heading must accept its toolbar's width")
        }
    }
}
