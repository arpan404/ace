import SwiftUI

/// `--loopback-rules` (fixture builds only): the device page rules on a real phone, where
/// loopback behaves as it does for people (the simulator uses the Mac's network stack). Runs
/// `PageRulesScenario.all` with `PageRulesRun` and prints each as a `[loopback-rules]` line, so a
/// device launched with `--console` shows them.
enum PageRulesCheck {
    static var enabled: Bool {
        #if ACE_FIXTURE
        ProcessInfo.processInfo.arguments.contains("--loopback-rules")
        #else
        false
        #endif
    }
}

struct PageRulesCheckView: View {
    @State private var lines: [String] = ["Starting…"]
    var body: some View {
        ScrollView {
            Text(lines.joined(separator: "\n"))
                .font(.system(.footnote, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .accessibilityIdentifier("loopback.rules")
        }
        .task { await run() }
    }

    private func say(_ line: String) {
        print("[loopback-rules] \(line)")
        lines.append(line)
    }

    private func run() async {
        #if ACE_FIXTURE
        lines = []
        let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows.first }.first
        guard let run = await PageRulesRun.start(in: window) else { say("no network address; join Wi-Fi"); return }
        say("listening \(run.listening.listening) busy \(run.listening.busy) on port \(run.machinePort)")
        var failures = 0
        for scenario in PageRulesScenario.all {
            let reached = await run.run(scenario)
            let ok = reached == scenario.reaches
            if !ok { failures += 1 }
            say("\(ok ? "ok  " : "FAIL") \(scenario.name): reached \(reached ?? "nothing"), expected \(scenario.reaches ?? "nothing")")
        }
        run.stop()
        say(failures == 0 ? "done, all as expected" : "done, \(failures) not as expected")
        #endif
    }
}
