import Foundation

/// How a queued handoff becomes New thread's draft: on the machine it named while that one is
/// paired and can start threads (else the machine New thread would open on), in the project it
/// named (else that machine's last, else a chat), on that project's last picks. Its id is the
/// draft's command id, so seeding the same handoff again after a crash replays the one start.
enum NewThreadHandoff {
    /// The machine `handoff` starts on; nil while no paired machine can take it.
    static func machine(for handoff: Handoff, options: [NewThreadMachineOption], remembered: String?) -> String? {
        if let named = handoff.machineId, options.contains(where: { $0.hostId == named && $0.canOperate }) { return named }
        guard let fallback = NewThreadMemory.machine(options, remembered: remembered),
              options.first(where: { $0.hostId == fallback })?.canOperate == true else { return nil }
        return fallback
    }

    /// The draft `handoff` starts as on `machine`. `files` are its files already staged in the
    /// draft's folder.
    static func draft(_ handoff: Handoff, on machine: String, memory: NewThreadMemory, files: [StagedAttachment]) -> NewThreadDraft {
        var draft = memory.open(NewThreadDraft(), on: machine)
        // A machine other than the one it named has other projects: its own last one, or a chat.
        let named = handoff.machineId == machine ? handoff.projectId : nil
        let project = named ?? draft.projectId ?? NewThreadDraft.chat
        draft = memory.chose(project: project, in: draft)
        draft.text = handoff.text
        draft.files = files.map { NewThreadFile($0, workspaceId: project) }
        draft.commandId = handoff.id
        draft.handoff = handoff.id
        draft.autoSend = true
        return draft
    }
}

/// What the share extension and the intents may offer, from the machines and projects the app
/// has read: machines that can start threads, in pairing order, each with its projects as the
/// machine lists them (recent first) and a chat.
extension HandoffCatalogue {
    static func make(machines: [(id: String, name: String, canOperate: Bool, projects: [ComposeProject]?)],
                     previous: HandoffCatalogue, memory: NewThreadMemory) -> HandoffCatalogue {
        var next = HandoffCatalogue()
        next.machines = machines.map { Machine(id: $0.id, name: $0.name, canOperate: $0.canOperate) }
        for machine in machines where machine.canOperate {
            // A machine whose projects weren't read this time keeps the ones read before.
            let listed = machine.projects.map { rows in
                rows.map { Project(machineId: machine.id, projectId: $0.id, name: $0.name) }
            } ?? previous.projects.filter { $0.machineId == machine.id && $0.projectId != NewThreadDraft.chat }
            next.projects += listed
            next.projects.append(Project(machineId: machine.id, projectId: NewThreadDraft.chat, name: "No project"))
        }
        next.lastMachine = memory.machine
        next.lastProject = memory.machine.flatMap { memory.choices[$0]?.projectId }
        return next
    }
}
