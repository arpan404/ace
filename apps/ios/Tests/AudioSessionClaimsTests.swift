import Testing
@testable import Ace

/// Who sets up the app's one audio session: a recording isn't cut off by page sound, and the
/// session goes inactive only once nobody holds it.
@Suite struct AudioSessionClaimsTests {
    @Test func pageSoundEndingDuringDictationLeavesTheSessionToDictation() {
        var claims = AudioSessionClaims()
        #expect(claims.claim(1, .pageSound) == .activate(.pageSound))
        #expect(claims.claim(2, .dictation) == .activate(.dictation))
        // The browser closes while the person dictates: nothing changes for the microphone.
        #expect(claims.release(1) == .none)
        #expect(claims.release(2) == .deactivate(idle: nil))
    }

    @Test func pageSoundStartingDuringARecordingDoesntTakeTheSession() {
        var claims = AudioSessionClaims()
        _ = claims.claim(1, .voiceRecording)
        #expect(claims.claim(2, .pageSound) == .none)
        // The recording ends: the page's sound sets the session up for playback.
        #expect(claims.release(1) == .activate(.pageSound))
        #expect(claims.release(2) == .deactivate(idle: nil))
    }

    @Test func amongEqualsTheNewestSetsTheSessionUp() {
        var claims = AudioSessionClaims()
        _ = claims.claim(1, .pageSound)
        #expect(claims.claim(2, .voicePlayback) == .activate(.voicePlayback))
        #expect(claims.release(2) == .activate(.pageSound))
    }

    @Test func theIdleCategoryHoldsOnlyWhileNobodyHoldsTheSession() {
        var claims = AudioSessionClaims()
        _ = claims.claim(1, .dictation)
        // Picture-in-picture asks for playback while the person dictates: dictation keeps it.
        #expect(claims.setIdle(.pageSound) == .none)
        #expect(claims.release(1) == .deactivate(idle: .pageSound))
        #expect(claims.setIdle(.pageSound) == .category(.pageSound))
    }

    @Test func releasingTwiceChangesNothing() {
        var claims = AudioSessionClaims()
        _ = claims.claim(1, .pageSound)
        _ = claims.release(1)
        #expect(claims.release(1) == .none)
    }
}
