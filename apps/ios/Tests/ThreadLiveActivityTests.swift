import Foundation
import Testing
@testable import Ace

/// The Live Activity freshness policy: unchanged canonical rows still renew `staleDate`,
/// and only a canonical done row while online ever ends its activity.
@Suite struct ThreadLiveActivityTests {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    @Test func aFirstSightingRefreshesAtOnce() {
        #expect(ThreadLiveActivity.shouldRefresh(last: nil, key: "Working", now: t0, renewalInterval: 30))
    }

    @Test func aChangedCanonicalStatusRefreshesBeforeTheIntervalPasses() {
        let last = (key: "Working", refreshedAt: t0)
        #expect(ThreadLiveActivity.shouldRefresh(last: last, key: "Approve", now: t0.addingTimeInterval(5), renewalInterval: 30))
    }

    @Test func anUnchangedRowWaitsOutTheRenewalInterval() {
        let last = (key: "Working", refreshedAt: t0)
        #expect(!ThreadLiveActivity.shouldRefresh(last: last, key: "Working", now: t0.addingTimeInterval(29), renewalInterval: 30))
    }

    @Test func anUnchangedRowRenewsOnceTheIntervalPasses() {
        let last = (key: "Working", refreshedAt: t0)
        #expect(ThreadLiveActivity.shouldRefresh(last: last, key: "Working", now: t0.addingTimeInterval(30), renewalInterval: 30))
    }

    @Test func onlyACanonicalDoneRowWhileOnlineEndsItsActivity() {
        #expect(ThreadLiveActivity.shouldEnd(state: "done", online: true))
        #expect(!ThreadLiveActivity.shouldEnd(state: "done", online: false))
        #expect(!ThreadLiveActivity.shouldEnd(state: "working", online: true))
        #expect(!ThreadLiveActivity.shouldEnd(state: "working", online: false))
    }

    @Test func theDedupKeyCoversTitleStatusAndConnectivity() throws {
        let working = try JSONDecoder().decode(ThreadRow.self, from: Data(workingJSON.utf8))
        let online = ThreadLiveActivity.key(row: working, online: true)
        #expect(ThreadLiveActivity.key(row: working, online: true) == online)
        #expect(ThreadLiveActivity.key(row: working, online: false) != online)
        let renamed = try JSONDecoder().decode(ThreadRow.self, from: Data(workingJSON.replacingOccurrences(of: "Fix login", with: "Fix logout").utf8))
        #expect(ThreadLiveActivity.key(row: renamed, online: true) != online)
        let needsYou = try JSONDecoder().decode(ThreadRow.self, from: Data(needsYouJSON.utf8))
        #expect(ThreadLiveActivity.key(row: needsYou, online: true) != online)
    }

    private let workingJSON = """
        {"id":"t1","title":"Fix login","state":"working","project":"ace","branch":"main",\
        "machine":"mbp","provider":"claude","model":"opus","agents":1,"updatedAt":0,\
        "canSteer":true,"status":{"label":"Working","token":"working"}}
        """
    private let needsYouJSON = """
        {"id":"t1","title":"Fix login","state":"needs_you","project":"ace","branch":"main",\
        "machine":"mbp","provider":"claude","model":"opus","agents":1,"updatedAt":0,\
        "canSteer":true,"status":{"label":"Approve","token":"needsYou"}}
        """
}
