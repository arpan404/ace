import Foundation
import Testing
@testable import Ace

/// Siri's Ask Spade: which machine the words go to, the one sentence when none can take them,
/// and what Siri says back.
@Suite struct SpadeAskTests {
    @Test func theWordsGoToTheMachineTheNewestHostChoiceNames() {
        let choice = SpadeAsk.choose([
            reached("laptop", record: record("laptop", 1), created: 1),
            reached("studio", record: record("studio", 2), created: 9),
        ])
        #expect(choice == .send(machine: "studio", conversation: "c-studio", after: 4))
    }

    @Test func beforeAnyChoiceTheOldestSpadeAnswering() {
        let choice = SpadeAsk.choose([reached("laptop", created: 9), reached("studio", created: 2)])
        #expect(choice == .send(machine: "studio", conversation: "c-studio", after: 4))
    }

    @Test func aChosenHostOutOfReachIsNamedAndNothingGoesElsewhere() {
        let choice = SpadeAsk.choose([
            reached("laptop", record: record("studio", 3), created: 1),
            .init(key: "studio", name: "Studio", main: nil, refusal: nil),
        ])
        #expect(choice == .cannot("Spade's computer, Studio, can't be reached right now, so Spade didn't get that."))
    }

    @Test func aChosenHostThisPhoneDoesNotKnowStillSendsNowhere() {
        let choice = SpadeAsk.choose([reached("laptop", record: record("server", 3), created: 1)])
        #expect(choice == .cannot("The computer Spade runs on can't be reached right now, so Spade didn't get that."))
    }

    @Test func noMachineReachableSaysSoInOneSentence() {
        let cases: [(machines: [SpadeAsk.Reach], said: String)] = [
            ([], "Pair a computer with ace first, then ask Spade again."),
            ([.init(key: "laptop", name: "Laptop", main: nil, refusal: nil)],
             "None of your computers can be reached right now, so Spade didn't get that."),
            // Reached, but its Spade can't answer: its own sentence.
            ([.init(key: "laptop", name: "Laptop", main: nil, refusal: "Spade is starting.")], "Spade is starting."),
        ]
        for (machines, said) in cases {
            #expect(SpadeAsk.choose(machines) == .cannot(said))
        }
    }

    @Test func siriReadsTheReplysFirstSentenceWithoutItsMarkup() {
        #expect(SpadeAsk.said(.replied("**Two meetings** today. The first is at ten.")) == "Two meetings today.")
        #expect(SpadeAsk.said(.replied("Done")) == "Done")
        #expect(SpadeAsk.said(.replied("See [the plan](https://example.com) now.\nMore below.")) == "See the plan now.")
    }

    @Test func aReplyStillComingSaysWhereItWillArrive() {
        #expect(SpadeAsk.said(.pending(notifies: true)) == "Spade is on it. Its reply will come as a notification.")
        #expect(SpadeAsk.said(.pending(notifies: false)) == "Spade is on it. Its reply will be in ace.")
        #expect(SpadeAsk.said(.replied("  ")) == "Spade is done. Its reply is in ace.")
        #expect(SpadeAsk.said(.refused("The endpoint is out of credit.")) == "The endpoint is out of credit.")
    }

    @Test func talkToSpadesLinkIsReadWithoutAMachine() {
        #expect(OpenedLink.withoutMachine(SpadeTalkLink.url) == OpenedLink(kind: "spade-talk"))
        #expect(OpenedLink.withoutMachine(URL(string: "ace://spade")!) == nil)
        #expect(OpenedLink.withoutMachine(URL(string: "ace://spade/elsewhere")!) == nil)
    }

    private func record(_ host: String, _ version: Int) -> SpadeModel.HostRecord {
        SpadeModel.HostRecord(host: host, version: version, at: 1, by: "person")
    }
    private func reached(_ key: String, record: SpadeModel.HostRecord? = nil, created: Double) -> SpadeAsk.Reach {
        SpadeAsk.Reach(key: key, name: key.capitalized,
                       main: .init(here: key, record: record, conversation: "c-\(key)", createdAt: created, after: 4),
                       refusal: nil)
    }
}
