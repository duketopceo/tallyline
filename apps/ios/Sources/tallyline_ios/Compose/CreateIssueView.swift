#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

private enum ComposeSheet: String, Identifiable {
    case team, priority, project, labels, assignee
    var id: String { rawValue }
}

/// New issue: title first, the properties people actually set as pills, and
/// the description last. Works offline: everything chosen is queued with the
/// issue.
struct CreateIssueView: View {
    var session: SessionModel
    let credential: DeviceCredential
    let onCreated: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var priority: IssuePriority = .none
    @State private var teamId = ""
    @State private var projectId: String?
    @State private var labelIds: Set<String> = []
    @State private var assignee: String?
    @State private var catalog = PickerCatalog()
    @State private var sheet: ComposeSheet?
    @State private var error: String?
    @State private var created = 0
    @FocusState private var titleFocused: Bool
    @Namespace private var pillSpace

    private var team: Team? { catalog.teams.first { $0.id == teamId } }

    private var canCreate: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !teamId.isEmpty
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    TextField("Title", text: $title, axis: .vertical)
                        .font(.title3.weight(.semibold))
                        .focused($titleFocused)
                        .submitLabel(.next)
                    pills
                    TextField("Description", text: $description, axis: .vertical)
                        .font(.body)
                        .lineLimit(3...10)
                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.callout)
                            .foregroundStyle(Theme.urgent)
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.canvas)
            .navigationTitle("New issue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }.disabled(!canCreate)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Button("Agent", systemImage: "sparkles") { open(.assignee) }
                    Button("Label", systemImage: "tag") { open(.labels) }
                    Button("Priority", systemImage: "chart.bar") { open(.priority) }
                    Spacer()
                }
            }
            .sheet(item: $sheet) { which in
                sheetContent(which).navigationTransition(.zoom(sourceID: which, in: pillSpace))
            }
            .sensoryFeedback(.success, trigger: created)
            .task {
                titleFocused = true
                if assignee == nil, let agent = UserDefaults.standard.string(forKey: "defaultAgentId"), !agent.isEmpty {
                    assignee = "agent:\(agent)"
                }
                await catalog.load(client: session.client, workspaceSlug: credential.workspaceSlug)
                if teamId.isEmpty { teamId = TeamMemory().pick(from: catalog.teams)?.id ?? "" }
            }
        }
    }

    private func open(_ which: ComposeSheet) {
        titleFocused = false
        sheet = which
    }

    private var pills: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                pill(.team) { PropertyPill(team?.name ?? "Team", systemImage: "person.2") }
                pill(.priority) { PropertyPill(priority.displayName) { PriorityGlyph(priority: priority) } }
                pill(.project) { PropertyPill(catalog.project(projectId)?.name ?? "Project", systemImage: "square.stack.3d.up") }
                pill(.labels) { PropertyPill(labelIds.isEmpty ? "Labels" : "\(labelIds.count) label\(labelIds.count == 1 ? "" : "s")", systemImage: "tag") }
                pill(.assignee) { PropertyPill(assigneeTitle, systemImage: assignee?.hasPrefix("agent:") == true ? "sparkles" : "person.crop.circle") }
            }
        }
        .scrollClipDisabled()
    }

    private func pill<Content: View>(_ which: ComposeSheet, @ViewBuilder _ content: () -> Content) -> some View {
        Button { open(which) } label: { content() }
            .buttonStyle(.plain)
            .matchedTransitionSource(id: which, in: pillSpace)
    }

    private var assigneeTitle: String {
        guard let assignee else { return "Assignee" }
        let parts = assignee.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return "Assignee" }
        if parts[0] == "agent" { return catalog.agent(parts[1])?.name ?? "Agent" }
        if parts[1] == credential.userId { return "You" }
        return catalog.member(userId: parts[1])?.title ?? "Assignee"
    }

    @ViewBuilder
    private func sheetContent(_ which: ComposeSheet) -> some View {
        switch which {
        case .team:
            PropertySheet(title: "Team", groups: catalog.teamGroups, selection: [teamId]) { chosen in
                if let id = chosen.first { teamId = id }
            }
        case .priority:
            PropertySheet(title: "Priority", groups: [PropertyGroup(options: IssuePriority.allCases.map(PropertyOption.priority))], selection: [priority.rawValue]) { chosen in
                if let raw = chosen.first, let next = IssuePriority(rawValue: raw) { priority = next }
            }
        case .project:
            PropertySheet(title: "Project", groups: catalog.projectGroups, selection: projectId.map { [$0] } ?? [], clearTitle: "No project") { chosen in
                projectId = chosen.first
            }
        case .labels:
            PropertySheet(title: "Labels", groups: catalog.labelGroups, selection: labelIds, allowsMultiple: true) { chosen in
                labelIds = chosen
            }
        case .assignee:
            PropertySheet(title: "Assignee", groups: catalog.assigneeGroups, selection: assignee.map { [$0] } ?? [], clearTitle: "Unassigned") { chosen in
                assignee = chosen.first
            }
        }
    }

    private func create() async {
        var draft = IssueCreate(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.isEmpty ? nil : description,
            teamId: teamId, teamKey: team?.key.nonEmpty ?? TeamMemory().teamKey(forId: teamId),
            priority: priority, projectId: projectId,
            labelIds: labelIds.isEmpty ? nil : Array(labelIds).sorted()
        )
        if let assignee {
            let parts = assignee.split(separator: ":", maxSplits: 1).map(String.init)
            if parts.count == 2 {
                draft.assigneeType = parts[0]
                draft.assigneeId = parts[1]
            }
        }
        TeamMemory().teamId = teamId
        switch await session.offline.submit(.createIssue(draft), workspaceSlug: credential.workspaceSlug) {
        case .sent, .queued:
            // Queued drafts show in Settings > Outbox until they send.
            created += 1
            await onCreated()
            dismiss()
        case .rejected(let reason):
            error = reason
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

#endif
