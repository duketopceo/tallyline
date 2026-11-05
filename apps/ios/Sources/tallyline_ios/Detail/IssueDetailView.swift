#if os(iOS)
import SwiftUI
import UIKit
import TallylineCore
import TallylineDesign

/// Which property sheet is open.
private enum DetailSheet: String, Identifiable {
    case state, priority, project, cycle, labels, assignee, team
    var id: String { rawValue }
}

/// Issue detail: properties as pills that open sheets, the review decision in
/// the toolbar, comments as a thread, and a composer pinned above the keyboard.
struct IssueDetailView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State var issue: Issue
    @State private var comments: [IssueComment] = []
    @State private var draft = ""
    @State private var actionError: String?
    @State private var pendingNote: String?
    @State private var catalog = PickerCatalog()
    @State private var sheet: DetailSheet?
    @State private var approvals = 0
    @State private var sendBacks = 0
    @FocusState private var composing: Bool
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var showInspector = true
    private var isRegular: Bool { sizeClass == .regular }
    @Namespace private var pillSpace

    private var actions: IssueActions { IssueActions(session: session, credential: credential) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if !isRegular { pills }
                statusLine
                commentThread
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.canvas)
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle(issue.key)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .inspector(isPresented: Binding(get: { isRegular && showInspector }, set: { showInspector = $0 })) {
            inspector.inspectorColumnWidth(min: 240, ideal: 280, max: 340)
        }
        .sheet(item: $sheet) { which in
            sheetContent(which)
                .navigationTransition(.zoom(sourceID: which, in: pillSpace))
        }
        .onChange(of: session.offline.cachedIssue(key: issue.key)) { _, fresh in
            // An edit made elsewhere (a swipe in the list column) shows here too.
            if let fresh, fresh != issue { issue = fresh }
        }
        .sensoryFeedback(.success, trigger: approvals)
        .sensoryFeedback(.warning, trigger: sendBacks)
        .task {
            await catalog.load(client: session.client, workspaceSlug: credential.workspaceSlug)
            await loadComments()
        }
    }

    // ── Header and pills ────────────────────────────────────────────────

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(issue.key).font(.caption.monospaced()).foregroundStyle(Theme.inkSubtle)
                if issue.creatorType == "agent" { Glint() }
            }
            Text(issue.title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.ink)
                .textSelection(.enabled)
            if let desc = issue.description, !desc.isEmpty {
                Text(desc)
                    .font(.body)
                    .foregroundStyle(Theme.inkMuted)
                    .textSelection(.enabled)
            }
        }
    }

    private var pills: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                pill(.state) { PropertyPill(issue.state.displayName) { StateGlyph(state: issue.state) } }
                pill(.priority) { PropertyPill(issue.priority.displayName) { PriorityGlyph(priority: issue.priority) } }
                pill(.assignee) { PropertyPill(assigneeTitle, systemImage: assigneeSymbol, tint: assigneeIsAgent ? Theme.glint : Theme.inkMuted) }
                pill(.project) { PropertyPill(catalog.project(issue.projectId)?.name ?? "No project", systemImage: "square.stack.3d.up") }
                pill(.cycle) { PropertyPill(catalog.cycle(issue.cycleId)?.title ?? "No cycle", systemImage: "arrow.triangle.2.circlepath") }
                pill(.labels) { PropertyPill(labelsTitle, systemImage: "tag") }
                if hasTeam { pill(.team) { PropertyPill(teamTitle, systemImage: "person.2") } }
            }
        }
        .scrollClipDisabled()
    }

    private func pill<Content: View>(_ which: DetailSheet, @ViewBuilder _ content: () -> Content) -> some View {
        Button { sheet = which } label: { content() }
            .buttonStyle(.plain)
            .matchedTransitionSource(id: which, in: pillSpace)
    }

    /// The team control only appears when the server sent the issue's team
    /// and there is somewhere else to move it.
    private var hasTeam: Bool { issue.teamId != nil && catalog.teams.count > 1 }

    private var teamTitle: String { catalog.team(issue.teamId)?.name ?? "Team" }

    private var assigneeIsAgent: Bool { issue.assigneeType == "agent" && issue.assigneeId != nil }

    private var assigneeSymbol: String { assigneeIsAgent ? "sparkles" : "person.crop.circle" }

    private var assigneeTitle: String {
        guard let id = issue.assigneeId else { return "Unassigned" }
        if assigneeIsAgent { return catalog.agent(id)?.name ?? "Agent" }
        if id == credential.userId { return "You" }
        return catalog.member(userId: id)?.title ?? "Assigned"
    }

    private var labelsTitle: String {
        let names = (issue.labels ?? []).map(\.name)
        switch names.count {
        case 0: return "No labels"
        case 1: return names[0]
        default: return "\(names[0]) +\(names.count - 1)"
        }
    }

    @ViewBuilder
    private var statusLine: some View {
        if let pendingNote {
            Label(pendingNote, systemImage: "tray.and.arrow.up").font(.callout).foregroundStyle(Theme.inkMuted)
        }
        if let actionError {
            Label(actionError, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(Theme.urgent)
        }
    }

    // ── Sheets ──────────────────────────────────────────────────────────

    @ViewBuilder
    private func sheetContent(_ which: DetailSheet) -> some View {
        switch which {
        case .state:
            PropertySheet(
                title: "State",
                groups: [PropertyGroup(options: ([issue.state] + issue.state.transitions).map(PropertyOption.state))],
                selection: [issue.state.rawValue]
            ) { chosen in
                if let raw = chosen.first, let next = IssueState(rawValue: raw), next != issue.state { edit(IssuePatch(state: next)) }
            }
        case .priority:
            PropertySheet(
                title: "Priority",
                groups: [PropertyGroup(options: IssuePriority.allCases.map(PropertyOption.priority))],
                selection: [issue.priority.rawValue]
            ) { chosen in
                if let raw = chosen.first, let next = IssuePriority(rawValue: raw), next != issue.priority { edit(IssuePatch(priority: next)) }
            }
        case .project:
            PropertySheet(title: "Project", groups: catalog.projectGroups, selection: issue.projectId.map { [$0] } ?? [], clearTitle: "No project") { chosen in
                if let id = chosen.first { edit(IssuePatch(projectId: id)) } else if issue.projectId != nil { edit(IssuePatch(cleared: [.project])) }
            }
        case .cycle:
            PropertySheet(title: "Cycle", groups: catalog.cycleGroups, selection: issue.cycleId.map { [$0] } ?? [], clearTitle: "No cycle") { chosen in
                if let id = chosen.first { edit(IssuePatch(cycleId: id)) } else if issue.cycleId != nil { edit(IssuePatch(cleared: [.cycle])) }
            }
        case .labels:
            PropertySheet(title: "Labels", groups: catalog.labelGroups, selection: Set((issue.labels ?? []).map(\.id)), allowsMultiple: true) { chosen in
                let patch = IssuePatch(labelIds: Array(chosen).sorted())
                edit(patch, labels: catalog.labels.filter { chosen.contains($0.id) }.map { IssueLabel(id: $0.id, name: $0.name, color: $0.color) })
            }
        case .assignee:
            let current = issue.assigneeId.map { "\(assigneeIsAgent ? "agent" : "human"):\($0)" }
            PropertySheet(title: "Assignee", groups: catalog.assigneeGroups, selection: current.map { [$0] } ?? [], clearTitle: "Unassigned") { chosen in
                guard let picked = chosen.first else {
                    if issue.assigneeId != nil { edit(IssuePatch(cleared: [.assignee])) }
                    return
                }
                let parts = picked.split(separator: ":", maxSplits: 1).map(String.init)
                if parts.count == 2 { edit(IssuePatch(assigneeType: parts[0], assigneeId: parts[1])) }
            }
        case .team:
            PropertySheet(title: "Team", groups: catalog.teamGroups, selection: issue.teamId.map { [$0] } ?? []) { chosen in
                if let id = chosen.first, id != issue.teamId { edit(IssuePatch(teamId: id)) }
            }
        }
    }

    /// iPad: the same properties as rows in a side column.
    private var inspector: some View {
        List {
            inspectorRow("State", .state) { HStack(spacing: 6) { StateGlyph(state: issue.state); Text(issue.state.displayName) } }
            inspectorRow("Priority", .priority) { HStack(spacing: 6) { PriorityGlyph(priority: issue.priority); Text(issue.priority.displayName) } }
            inspectorRow("Assignee", .assignee) { Text(assigneeTitle) }
            inspectorRow("Project", .project) { Text(catalog.project(issue.projectId)?.name ?? "None") }
            inspectorRow("Cycle", .cycle) { Text(catalog.cycle(issue.cycleId)?.title ?? "None") }
            inspectorRow("Labels", .labels) { Text(labelsTitle) }
            if hasTeam { inspectorRow("Team", .team) { Text(teamTitle) } }
        }
    }

    private func inspectorRow<Value: View>(_ title: String, _ which: DetailSheet, @ViewBuilder _ value: () -> Value) -> some View {
        Button { sheet = which } label: {
            LabeledContent(title) { value().foregroundStyle(Theme.ink) }
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .matchedTransitionSource(id: which, in: pillSpace)
    }

    // ── Toolbar: review decision ────────────────────────────────────────

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if isRegular {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showInspector.toggle() } label: { Image(systemName: "sidebar.trailing") }
                    .accessibilityLabel(showInspector ? "Hide properties" : "Show properties")
            }
        }
        if issue.state == .inReview {
            ToolbarItem(placement: .confirmationAction) {
                Button("Approve") { Task { await review("approve") } }
            }
        }
        // One menu for the rest. Copy link is absent when the server sent no url.
        if issue.state == .inReview || IssueLink.copyable(issue) != nil {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if let link = IssueLink.copyable(issue) {
                        Button("Copy link", systemImage: "link") { UIPasteboard.general.string = link }
                    }
                    if issue.state == .inReview {
                        Button("Send back", systemImage: "arrow.uturn.backward", role: .destructive) {
                            Task { await review("send_back") }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("More")
            }
        }
    }

    // ── Comments and composer ───────────────────────────────────────────

    private var commentThread: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !comments.isEmpty {
                Text("Comments").font(.footnote.smallCaps()).foregroundStyle(Theme.inkMuted)
            }
            ForEach(comments) { comment in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        if comment.actorType == "agent" { Glint() }
                        Text(comment.actorType.capitalized).font(.caption).foregroundStyle(Theme.inkSubtle)
                        Text(comment.createdAt, format: .relative(presentation: .numeric, unitsStyle: .abbreviated))
                            .font(.caption2)
                            .foregroundStyle(Theme.inkSubtle)
                    }
                    Text(comment.body).font(.callout).foregroundStyle(Theme.ink).textSelection(.enabled)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.bottom, 8)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Comment", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .focused($composing)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radiusXl))
            Button {
                Task { await postComment() }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title2)
            }
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send comment")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.bar)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Button("Agent", systemImage: "sparkles") { composing = false; sheet = .assignee }
                Button("Label", systemImage: "tag") { composing = false; sheet = .labels }
                Spacer()
                Button("Done") { composing = false }
            }
        }
    }

    // ── Writes ──────────────────────────────────────────────────────────

    private func edit(_ patch: IssuePatch, labels: [IssueLabel]? = nil) {
        Task { await patchIssue(patch, labels: labels) }
    }

    private func patchIssue(_ patch: IssuePatch, labels: [IssueLabel]? = nil) async {
        let before = issue
        var next = issue.applying(patch)
        if let labels { next.labels = labels }
        issue = next
        actionError = nil
        let outcome = await actions.apply(patch, to: before, optimistic: next)
        switch outcome {
        case .sent:
            pendingNote = nil
            if let client = session.client, let fresh = try? await client.issue(ws: credential.workspaceSlug, key: issue.key) {
                issue = fresh
                session.offline.applyLocally(fresh)
            }
        case .queued:
            pendingNote = "Saved on this phone. It sends when you're back online."
        case .rejected(let reason):
            issue = before
            actionError = reason
        }
    }

    private func review(_ decision: String) async {
        guard let client = session.client else { return }
        do {
            issue = try await client.reviewIssue(ws: credential.workspaceSlug, key: issue.key, decision: decision)
            session.offline.applyLocally(issue)
            if decision == "approve" { approvals += 1 } else { sendBacks += 1 }
        } catch let APIClientError.http(_, _, m) {
            actionError = m ?? "Review failed."
            sendBacks += 1
        } catch {
            actionError = "Review failed. Check your connection."
            sendBacks += 1
        }
    }

    private func postComment() async {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        draft = ""
        actionError = nil
        switch await session.offline.submit(.addComment(key: issue.key, body: body), workspaceSlug: credential.workspaceSlug) {
        case .sent:
            pendingNote = nil
            await loadComments()
        case .queued:
            pendingNote = "Comment saved on this phone. It sends when you're back online."
        case .rejected(let reason):
            draft = body
            actionError = reason
        }
    }

    private func loadComments() async {
        guard let client = session.client else { return }
        comments = (try? await client.comments(ws: credential.workspaceSlug, key: issue.key)) ?? []
    }
}

/// Fetches an issue by key, then shows its detail.
struct IssueLoaderView: View {
    var session: SessionModel
    let credential: DeviceCredential
    let key: String
    @State private var issue: Issue?
    @State private var failure: IssueLoadFailure?

    var body: some View {
        Group {
            if let issue {
                IssueDetailView(session: session, credential: credential, issue: issue)
            } else if let failure {
                ContentUnavailableView(failure.title, systemImage: failure.isNotFound ? "questionmark.folder" : "exclamationmark.triangle", description: Text(failure.detail))
            } else {
                ProgressView()
            }
        }
        .task {
            guard let client = session.client else { return }
            do { issue = try await client.issue(ws: credential.workspaceSlug, key: key) }
            catch { failure = IssueLoadFailure.describe(error, key: key) }
        }
    }
}
#endif
