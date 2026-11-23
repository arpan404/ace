import SwiftUI

/// Computer › Services (web's `bot-services.tsx`): the processes the bot keeps running, a tool
/// and never work, so nothing here makes it read as busy. Each row: its name and command, how it
/// is, Stop while it runs and Start once it ended (its own command again); tapping it opens its
/// output in place under it, read again every two seconds while it runs. Reads stop when the page goes or the app leaves the front.
struct SpadeComputerServices: View {
    let model: ClientModel
    let agent: String
    let name: String
    @Environment(\.scenePhase) private var scene
    @State private var services: [SpadeService]?
    @State private var problem: String?
    @State private var open: String?
    @State private var busy: Set<String> = []
    @State private var alert: String?

    var body: some View {
        List {
            if let services {
                if services.isEmpty {
                    Text("\(name) isn't running any services.").foregroundStyle(AceDesign.Ink.muted)
                }
                ForEach(services) { service in
                    Section {
                        row(service)
                        if open == service.id {
                            SpadeServiceLog(model: model, agent: agent, service: service)
                                .id(service.restarts)
                        }
                    }
                }
            } else if let problem {
                ProblemRow(problem, id: "spade.services.problem") { Task { await load() } }
            } else {
                SkeletonRows(count: 2).listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await load() }
        .navigationTitle("Services")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: "\(scene)-\(model.connection)") {
            guard scene == .active, model.connection == "ready" else { return }
            while !Task.isCancelled {
                await load()
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
        .alert(alert ?? "", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
            Button("Close", role: .cancel) { alert = nil }
        }
    }

    private func row(_ service: SpadeService) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            Button { open = open == service.id ? nil : service.id } label: {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(service.name).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                    Text(service.command).aceFont(AceDesign.TextRole.code).foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
                    Text(service.words)
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(service.failed ? AceDesign.Status.failed : service.running ? AceDesign.Status.working : AceDesign.Ink.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(service.name): \(service.words). Output")
            .accessibilityHint(open == service.id ? "Hides its output" : "Shows its output")
            if service.running {
                Button(busy.contains(service.id) ? "Stopping…" : "Stop", role: .destructive) { Task { await stop(service) } }
                    .buttonStyle(.secondaryAction)
                    .frame(minHeight: AceDesign.Size.tap)
                    .disabled(busy.contains(service.id) || !model.canOperate)
                    .accessibilityIdentifier("spade.service.stop")
            } else if service.startable {
                Button(busy.contains(service.id) ? "Starting…" : "Start") { Task { await start(service) } }
                    .buttonStyle(.secondaryAction)
                    .frame(minHeight: AceDesign.Size.tap)
                    .disabled(busy.contains(service.id) || !model.canOperate)
                    .accessibilityIdentifier("spade.service.start")
            }
        }
    }

    private func load() async {
        let reply = await model.spadeComputer(["type": "spade.services", "agentId": agent], failing: "Couldn't read the services")
        guard !Task.isCancelled else { return }
        if let read = reply.services { services = read; problem = nil } else if services == nil { problem = reply.problem }
    }

    private func stop(_ service: SpadeService) async {
        await act(on: service, "spade.services.stop", failing: "Couldn't stop \(service.name)")
    }

    private func start(_ service: SpadeService) async {
        await act(on: service, "spade.services.start", failing: "Couldn't start \(service.name)")
    }

    private func act(on service: SpadeService, _ type: String, failing: String) async {
        busy.insert(service.id)
        defer { busy.remove(service.id) }
        let reply = await model.spadeComputer(["type": type, "agentId": agent, "service": service.id], failing: failing)
        if let problem = reply.problem { alert = problem }
        await load()
    }
}

/// A service's output, under its row: the last lines kept, then, while it runs, what it prints
/// next, read every two seconds. At most 2,000 lines stay; older ones fall off the top.
private struct SpadeServiceLog: View {
    let model: ClientModel
    let agent: String
    let service: SpadeService
    @Environment(\.scenePhase) private var scene
    @State private var lines: [SpadeServiceLine]?
    @State private var problem: String?
    private static let kept = 2_000

    var body: some View {
        Group {
            if let lines {
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(lines.isEmpty ? "No output yet" : lines.map(\.text).joined(separator: "\n"))
                            .aceFont(AceDesign.TextRole.code)
                            .foregroundStyle(lines.isEmpty ? AceDesign.Ink.muted : AceDesign.Ink.primary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Color.clear.frame(height: AceTheme.Dimensions.border).id("end")
                    }
                    .frame(maxHeight: AceDesign.Size.rowThread * 4)
                    .onChange(of: lines.last?.n) { proxy.scrollTo("end", anchor: .bottom) }
                }
                .accessibilityLabel("\(service.name)'s output")
            } else if let problem {
                Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            } else {
                SkeletonRows(count: 2)
            }
        }
        .task(id: "\(scene)-\(service.running)") {
            guard scene == .active else { return }
            while !Task.isCancelled {
                await read()
                guard service.running else { return }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
    }

    private func read() async {
        let after = lines?.last?.n ?? 0
        let reply = await model.spadeComputer(["type": "spade.services.logs", "agentId": agent, "service": service.id, "after": after],
                                              failing: "Couldn't read the output")
        guard !Task.isCancelled else { return }
        guard let got = reply.lines else { problem = reply.problem; return }
        let all = (lines ?? []) + got
        lines = all.count > Self.kept ? Array(all.suffix(Self.kept)) : all
        problem = nil
    }
}
