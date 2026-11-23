import Foundation
import Testing
@testable import Ace

struct PhoneUpdateTests {
    @Test("a beta is older than its release and newer than the earlier beta")
    func betaOrder() {
        #expect(AppVersion.isNewer("0.0.25", than: "0.0.25-beta.3"))
        #expect(AppVersion.isNewer("0.0.25-beta.3", than: "0.0.25-beta.2"))
        #expect(!AppVersion.isNewer("0.0.25-beta.3", than: "0.0.25"))
        #expect(AppVersion.isNewer("0.0.25-beta.10", than: "0.0.25-beta.9"))
        #expect(AppVersion.isNewer("0.1.0", than: "0.0.99"))
        #expect(!AppVersion.isNewer("1.2.3", than: "1.2.3+45"))
        #expect(!AppVersion.isNewer("garbage", than: "1.0.0"))
    }

    @Test("the install source follows the receipt and bundle id")
    func installSource() {
        #expect(PhoneInstall.detect(bundleId: "app.ace.ios", receipt: "receipt") == .appStore)
        #expect(PhoneInstall.detect(bundleId: "app.ace.ios", receipt: "sandboxReceipt") == .testFlight)
        #expect(PhoneInstall.detect(bundleId: "app.ace.ios", receipt: nil) == .development)
        #expect(PhoneInstall.detect(bundleId: "app.ace.ios.dev", receipt: "receipt") == .development)
    }

    @Test("a newer store listing offers the App Store page; an equal one doesn't")
    func decision() {
        let reply = Data(#"{"resultCount":1,"results":[{"version":"0.0.26","trackId":123}]}"#.utf8)
        let state = PhoneUpdate.decide(current: "0.0.25", listing: PhoneUpdate.listing(from: reply))
        #expect(state == .available(version: "0.0.26", storeURL: URL(string: "itms-apps://apps.apple.com/app/id123")!))
        #expect(PhoneUpdate.decide(current: "0.0.26", listing: PhoneUpdate.listing(from: reply)) == .upToDate)
        #expect(PhoneUpdate.decide(current: "0.0.25", listing: nil) == .upToDate)
    }

    @Test("the lookup sends only the bundle id")
    func lookup() {
        #expect(PhoneUpdate.lookupURL(bundleId: "app.ace.ios")?.absoluteString == "https://itunes.apple.com/lookup?bundleId=app.ace.ios")
    }

    @MainActor @Test("checking uses the injected fetcher and reports a failure")
    func model() async {
        let ok = PhoneUpdateModel(bundleId: "app.ace.ios", version: "0.0.25", build: "1", receipt: "receipt") { _ in
            Data(#"{"results":[{"version":"0.0.26","trackId":9}]}"#.utf8)
        }
        await ok.check()
        #expect(ok.state == .available(version: "0.0.26", storeURL: URL(string: "itms-apps://apps.apple.com/app/id9")!))
        struct Down: Error {}
        let bad = PhoneUpdateModel(bundleId: "app.ace.ios", version: "0.0.25", build: "1", receipt: "receipt") { _ in throw Down() }
        await bad.check()
        #expect(bad.state == .failed)
        let dev = PhoneUpdateModel(bundleId: "app.ace.ios", version: "0.0.25", build: "1", receipt: nil) { _ in throw Down() }
        await dev.check()
        #expect(dev.state == .development)
    }
}
