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

struct ComputerUpdateTests {
    private func info(_ phase: String = "current", available: String? = nil, percent: Double? = nil,
                      error: String? = nil, blocked: String? = nil, known: Bool = true) -> MachineUpdateInfo {
        MachineUpdateInfo(known: known, version: "0.0.24", available: available, line: nil, phase: phase,
                          percent: percent, error: error, blocked: blocked, busy: 0)
    }
    private func step(_ info: MachineUpdateInfo, checked: Bool = false, asking: Bool = false) -> ComputerUpdateStep {
        ComputerUpdate.step(info, machine: "Studio", checked: checked, asking: asking)
    }

    @Test("the row walks check, up to date, update, downloading, restarting")
    func steps() {
        #expect(step(info()) == .check)
        #expect(step(info(), asking: true) == .checking)
        #expect(step(info(), checked: true) == .upToDate)
        #expect(step(info("available", available: "0.0.25")) == .available("0.0.25"))
        #expect(step(info("downloading", available: "0.0.25", percent: 49.6)) == .downloading(50))
        #expect(step(info("restarting", available: "0.0.25")) == .restarting)
        #expect(step(info("waiting", available: "0.0.25")) == .waiting)
    }

    @Test("a closed desktop app, a refusal and an old daemon each say so in plain words")
    func edges() {
        #expect(step(info(available: "0.0.25", blocked: "app-closed")) == .blocked("Open ace on Studio to update it"))
        #expect(step(info("failed", error: "No space left.")) == .failed("No space left."))
        #expect(step(info(known: false)) == .versionOnly)
    }

    @Test("updating now lists the agents it will stop")
    func nowDetail() {
        #expect(ComputerUpdate.nowDetail([]) == "No agents are working.")
        #expect(ComputerUpdate.nowDetail(["Fix login"]).contains("Fix login"))
        #expect(ComputerUpdate.nowDetail(["a", "b", "c", "d", "e", "f", "g"]).contains("and 2 more"))
    }
}

struct ComputerRowTests {
    @Test("the computer row always says something: its version, an old daemon, or that it is waiting")
    func alwaysSomething() {
        let app = MachineAppUpdateInfo(known: true, version: "0.0.24", line: nil, needsYou: false)
        let unknown = MachineAppUpdateInfo(known: true, version: "Unknown", line: nil, needsYou: false)
        #expect(ComputerUpdate.knownVersion(update: nil, app: app, daemon: nil) == "0.0.24")
        #expect(ComputerUpdate.knownVersion(update: nil, app: unknown, daemon: "0.0.23") == "0.0.23")
        #expect(ComputerUpdate.knownVersion(update: nil, app: nil, daemon: nil) == nil)
        #expect(ComputerUpdate.readOnly(machine: "Studio", version: nil).line == "Waiting for Studio…")
        let old = ComputerUpdate.readOnly(machine: "Studio", version: "0.0.24")
        #expect(old.title == "Studio: ace 0.0.24")
        #expect(old.line == "Updates run on Studio")
    }
}

struct MachineConnectionWordsTests {
    private let stale = StatusDisplay(label: "Can't reach", token: "neutral")

    @Test("a connected client reads Connected, even beside an older status line")
    func connected() {
        let words = MachineConnectionWords.of(state: "ready", status: stale)
        #expect(words.display.label == "Connected")
        #expect(words.display.token == "done")
        #expect(!words.trying)
    }

    @Test("a reconnecting client reads Reconnecting; a first connect reads Connecting")
    func reconnecting() {
        let again = MachineConnectionWords.of(state: "reconnecting", status: nil)
        #expect(again.display.label == "Reconnecting")
        #expect(again.trying)
        let first = MachineConnectionWords.of(state: "connecting", status: nil)
        #expect(first.display.label == "Connecting…")
        #expect(first.trying)
    }

    @Test("pairing and off win over the connection")
    func overrides() {
        #expect(MachineConnectionWords.of(state: "ready", status: nil, needsPairing: true).display.label == "Pair again")
        #expect(MachineConnectionWords.of(state: "ready", status: nil, off: true).display.label == "Off on this iPhone")
    }
}
