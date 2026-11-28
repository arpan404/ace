import Foundation
import Testing
@testable import Ace

/// The live browser's page sound (ADR 0088 › Audio): when the speaker shows and what a tap does,
/// which chunks may play, and when they play against the video.
@Suite struct BrowserSoundTests {
    private func tab(audible: Bool? = nil, muted: Bool? = nil) -> BrowserViewInfo.Shown {
        BrowserViewInfo.Shown(canGoBack: false, canGoForward: false, zoom: nil, agent: nil, private: false, pointer: nil,
                              muted: muted, audible: audible)
    }
    private func chunk(at timestamp: Double, tab: String? = "tab-1") -> BrowserAudioChunk {
        BrowserAudioChunk(threadId: "thread-1", sequence: 0, timestamp: timestamp, sampleRate: 48_000, channels: 2,
                          codec: "opus", tabId: tab, bytes: Data([1]))
    }

    // MARK: - Speaker

    @Test func aSilentPageShowsNoSpeaker() {
        #expect(BrowserSound.control(shown: tab(), here: false) == nil)
        #expect(BrowserSound.control(shown: nil, here: false) == nil)
    }

    @Test func aPlayingPageThisPhoneHasntTurnedOnOffersToPlayHere() {
        let control = BrowserSound.control(shown: tab(audible: true), here: false)
        #expect(control == BrowserSound(muted: true, label: "Turn on sound", step: .playHere))
    }

    @Test func oncePlayingHereATapMutesTheTabForEveryone() {
        let control = BrowserSound.control(shown: tab(audible: true), here: true)
        #expect(control == BrowserSound(muted: false, label: "Mute tab", step: .muteTab))
    }

    @Test func aMutedTabUnmutesAndTurnsSoundOnHereWhenItWasOff() {
        #expect(BrowserSound.control(shown: tab(audible: true, muted: true), here: false)?.step == .unmuteTab(hereToo: true))
        #expect(BrowserSound.control(shown: tab(muted: true), here: true)?.step == .unmuteTab(hereToo: false))
        // A phone that can't play the page's sound still offers the tab's own unmute.
        #expect(BrowserSound.control(shown: tab(muted: true), here: nil)?.step == .unmuteTab(hereToo: false))
        #expect(BrowserSound.control(shown: tab(audible: true), here: nil)?.step == .muteTab)
    }

    @Test func theAudioOutputIsOpenOnlyWhileTheShownTabPlaysUnmutedToAnOpenViewThatTurnedItOn() {
        #expect(BrowserSound.plays(here: true, open: true, shown: tab(audible: true)))
        #expect(!BrowserSound.plays(here: false, open: true, shown: tab(audible: true)))
        #expect(!BrowserSound.plays(here: true, open: false, shown: tab(audible: true)))
        #expect(!BrowserSound.plays(here: true, open: true, shown: tab(audible: true, muted: true)))
        #expect(!BrowserSound.plays(here: true, open: true, shown: tab(audible: false)))
    }

    // MARK: - Stale audio

    @Test func soundWaitsForTheStreamsFirstPictureAndDropsWhatWasCapturedBeforeIt() {
        var gate = AudioGate()
        gate.delivery(path: "media-1", reset: false)
        #expect(!gate.admits(chunk(at: 100), path: "media-1"))
        gate.shown(timestamp: 200, tabId: "tab-1")
        #expect(!gate.admits(chunk(at: 150), path: "media-1"))
        #expect(gate.admits(chunk(at: 220), path: "media-1"))
    }

    @Test func soundFromAnotherSocketOrAnUnsettledDeliveryIsDropped() {
        var gate = AudioGate()
        gate.delivery(path: "media-1", reset: false)
        gate.shown(timestamp: 0, tabId: nil)
        #expect(!gate.admits(chunk(at: 10), path: "main"))
        gate.delivery(path: nil, reset: false)
        #expect(!gate.admits(chunk(at: 10), path: "media-1"))
    }

    @Test func aNewStreamDropsTheOldOnesSoundUntilItsOwnFirstPicture() {
        var gate = AudioGate()
        gate.delivery(path: "media-1", reset: false)
        gate.shown(timestamp: 100, tabId: "tab-1")
        #expect(gate.admits(chunk(at: 500), path: "media-1"))
        // Another tab: the old tab's sound in flight is stale.
        gate.reset()
        #expect(!gate.admits(chunk(at: 510), path: "media-1"))
        gate.shown(timestamp: 600, tabId: "tab-2")
        #expect(!gate.admits(chunk(at: 610, tab: "tab-1"), path: "media-1"))
        #expect(gate.admits(chunk(at: 610, tab: "tab-2"), path: "media-1"))
        // A new subscribe by another socket starts over the same way.
        gate.delivery(path: "media-2", reset: true)
        #expect(!gate.admits(chunk(at: 700, tab: "tab-2"), path: "media-2"))
    }

    // MARK: - Playout

    @Test func soundPlaysItsBufferBehindItsQuickestArrivalAndBackToBack() {
        var playout = AudioPlayout()
        // Captured at 0, decoded at local 1000: plays 60 ms later.
        #expect(playout.schedule(timestamp: 0, duration: 20, now: 1_000) == 1_060)
        // The next packet, a little late, keeps the schedule: no gap.
        #expect(playout.schedule(timestamp: 20, duration: 20, now: 1_030) == 1_080)
    }

    @Test func soundWaitsForPicturesRunningLateButNoMoreThanHalfASecond() {
        var playout = AudioPlayout()
        playout.shown(timestamp: 0, at: 1_300)
        #expect(playout.schedule(timestamp: 0, duration: 20, now: 1_000) == 1_300)
        var far = AudioPlayout()
        far.shown(timestamp: 0, at: 5_000)
        #expect(far.schedule(timestamp: 0, duration: 20, now: 1_000) == 1_560)
    }

    @Test func aNewStreamForgetsTheOldVideosLead() {
        var playout = AudioPlayout()
        playout.shown(timestamp: 0, at: 1_300)
        _ = playout.schedule(timestamp: 0, duration: 20, now: 1_000)
        playout.reset()
        #expect(playout.schedule(timestamp: 1_000, duration: 20, now: 2_000) == 2_060)
    }
}
