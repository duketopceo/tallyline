#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// Signed-in shell: Triage / My issues / Review / Settings tabs.
struct HomeView: View {
    var session: SessionModel
    let credential: DeviceCredential

    var body: some View {
        TabView {
            IssueListView(session: session, credential: credential, state: .triage)
                .tabItem { Label("Triage", systemImage: "tray") }
            IssueListView(session: session, credential: credential, state: nil)
                .tabItem { Label("Issues", systemImage: "list.bullet") }
            ReviewQueueView(session: session, credential: credential)
                .tabItem { Label("Review", systemImage: "checkmark.circle") }
            SettingsView(session: session, credential: credential)
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(Theme.accent)
    }
}

/// A state-filtered issue list with pull-to-refresh and delta reloads.
struct IssueListView: View {
    var session: SessionModel
    let credential: DeviceCredential
    let state: IssueState?
    @State private var issues: [Issue] = []
    @State private var error: String?
    @State private var showCreate = false
    @State private var lastSync: Date?

    var body: some View {
        NavigationStack {
            Group {
                if let error {
                    ContentUnavailableView("Couldn't load", systemImage: "exclamationmark.triangle", description: Text(error))
                } else if issues.isEmpty {
                    ContentUnavailableView("Nothing here", systemImage: "checkmark", description: Text("No issues in this list."))
                } else {
                    List(issues) { issue in
                        NavigationLink(value: issue) { IssueRow(issue: issue) }
                    }
                }
            }
            .navigationTitle(state == .triage ? "Triage" : "Issues")
            .navigationDestination(for: Issue.self) { issue in
                IssueDetailView(session: session, credential: credential, issue: issue)
            }
            .toolbar {
                Button { showCreate = true } label: { Image(systemName: "plus") }
            }
            .refreshable { await reload() }
            .task { await reload() }
            .sheet(isPresented: $showCreate) {
                CreateIssueView(session: session, credential: credential) { await reload() }
            }
        }
    }

    private func reload() async {
        guard let client = session.client else { return }
        do {
            issues = try await client.issues(ws: credential.workspaceSlug, state: state, updatedSince: lastSync)
            lastSync = Date()
            error = nil
        } catch let APIClientError.http(_, _, message) {
            self.error = message ?? "load failed"
        } catch { self.error = "load failed" }
    }
}

struct IssueRow: View {
    let issue: Issue

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(issue.key).font(.caption.monospaced()).foregroundStyle(Theme.inkSubtle)
                if issue.creatorType == "agent" { Glint() }
                if issue.occurrenceCount > 1 {
                    Text("×\(issue.occurrenceCount)").font(.caption2).foregroundStyle(Theme.inkSubtle)
                }
                Spacer()
                Text(issue.priority.rawValue).font(.caption2).foregroundStyle(priorityColor)
            }
            Text(issue.title).font(.body).lineLimit(2)
            Text(issue.state.rawValue.replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(Theme.inkMuted)
        }
    }

    private var priorityColor: Color {
        switch issue.priority {
        case .urgent: .red
        case .high: .orange
        case .medium, .low: Theme.inkMuted
        case .none: Theme.inkSubtle
        }
    }
}

/// Four-point star marking agent-authored or agent-held work.
struct Glint: View {
    var body: some View {
        Image(systemName: "sparkle")
            .font(.caption2)
            .foregroundStyle(Theme.glint)
            .accessibilityLabel("agent")
    }
}

/// Issue detail: description, comments, state/priority controls, review actions.
struct IssueDetailView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State var issue: Issue
    @State private var comments: [IssueComment] = []
    @State private var draft = ""
    @State private var actionError: String?

    var body: some View {
        List {
            Section {
                Text(issue.title).font(.headline)
                if let desc = issue.description, !desc.isEmpty {
                    Text(desc).font(.body).foregroundStyle(Theme.inkMuted)
                }
            }
            Section("State") {
                Picker("State", selection: Binding(
                    get: { issue.state },
                    set: { newState in Task { await patch { $0.state = newState } } }
                )) {
                    ForEach(IssueState.allCases, id: \.self) { s in
                        Text(s.rawValue.replacingOccurrences(of: "_", with: " ")).tag(s)
                    }
                }
                Picker("Priority", selection: Binding(
                    get: { issue.priority },
                    set: { p in Task { await patch { $0.priority = p } } }
                )) {
                    ForEach(IssuePriority.allCases, id: \.self) { p in
                        Text(p.rawValue).tag(p)
                    }
                }
            }
            if issue.state == .inReview {
                Section("Review") {
                    Button("Approve") { Task { await review("approve") } }
                        .tint(Theme.accent)
                    Button("Send back", role: .destructive) { Task { await review("send_back") } }
                }
            }
            Section("Comments") {
                ForEach(comments) { comment in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            if comment.actorType == "agent" { Glint() }
                            Text(comment.actorType).font(.caption).foregroundStyle(Theme.inkSubtle)
                            Spacer()
                            Text(comment.createdAt, style: .relative).font(.caption2).foregroundStyle(Theme.inkSubtle)
                        }
                        Text(comment.body).font(.callout)
                    }
                }
                HStack {
                    TextField("Comment…", text: $draft).textFieldStyle(.roundedBorder)
                    Button("Post") { Task { await postComment() } }.disabled(draft.isEmpty)
                }
            }
            if let actionError {
                Section { Text(actionError).foregroundStyle(.red).font(.callout) }
            }
        }
        .navigationTitle(issue.key)
        .task { await loadComments() }
    }

    private func patch(_ mutate: (inout IssuePatch) -> Void) async {
        guard let client = session.client else { return }
        var p = IssuePatch()
        mutate(&p)
        do { issue = try await client.updateIssue(ws: credential.workspaceSlug, key: issue.key, p) }
        catch let APIClientError.http(_, _, m) { actionError = m ?? "update failed" }
        catch { actionError = "update failed" }
    }

    private func review(_ decision: String) async {
        guard let client = session.client else { return }
        do { issue = try await client.reviewIssue(ws: credential.workspaceSlug, key: issue.key, decision: decision) }
        catch let APIClientError.http(_, _, m) { actionError = m ?? "review failed" }
        catch { actionError = "review failed" }
    }

    private func postComment() async {
        guard let client = session.client else { return }
        do {
            _ = try await client.addComment(ws: credential.workspaceSlug, key: issue.key, body: draft)
            draft = ""
            await loadComments()
        } catch { actionError = "comment failed" }
    }

    private func loadComments() async {
        guard let client = session.client else { return }
        comments = (try? await client.comments(ws: credential.workspaceSlug, key: issue.key)) ?? []
    }
}

/// Review queue — `in_review` issues needing a human decision.
struct ReviewQueueView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State private var entries: [ReviewQueueEntry] = []

    var body: some View {
        NavigationStack {
            Group {
                if entries.isEmpty {
                    ContentUnavailableView("Queue clear", systemImage: "checkmark.circle", description: Text("Approved work lands here for your call."))
                } else {
                    List(entries, id: \.issue.id) { entry in
                        NavigationLink(value: entry.issue) { IssueRow(issue: entry.issue) }
                    }
                }
            }
            .navigationTitle("Review")
            .navigationDestination(for: Issue.self) { issue in
                IssueDetailView(session: session, credential: credential, issue: issue)
            }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func load() async {
        guard let client = session.client else { return }
        entries = (try? await client.reviewQueue(ws: credential.workspaceSlug)) ?? []
    }
}

/// New issue — title, team, priority, optional description.
struct CreateIssueView: View {
    var session: SessionModel
    let credential: DeviceCredential
    let onCreated: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var priority: IssuePriority = .none
    @State private var teams: [Team] = []
    @State private var teamId = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title)
                TextField("Description", text: $description, axis: .vertical).lineLimit(3...8)
                Picker("Team", selection: $teamId) {
                    ForEach(teams) { Text($0.name).tag($0.id) }
                }
                Picker("Priority", selection: $priority) {
                    ForEach(IssuePriority.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("New issue")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }.disabled(title.isEmpty || teamId.isEmpty)
                }
            }
            .task {
                guard let client = session.client else { return }
                teams = (try? await client.teams(ws: credential.workspaceSlug)) ?? []
                teamId = teams.first?.id ?? ""
            }
        }
    }

    private func create() async {
        guard let client = session.client else { return }
        do {
            _ = try await client.createIssue(ws: credential.workspaceSlug, IssueCreate(
                title: title, description: description.isEmpty ? nil : description,
                teamId: teamId, priority: priority
            ))
            await onCreated()
            dismiss()
        } catch let APIClientError.http(_, _, m) { self.error = m ?? "create failed" }
        catch { self.error = "create failed" }
    }
}

/// Workspace, device, sign-out.
struct SettingsView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State private var whoami: Whoami?

    var body: some View {
        NavigationStack {
            List {
                Section("Workspace") {
                    LabeledContent("Name", value: credential.workspaceName)
                    LabeledContent("Server", value: credential.serverURL.host ?? credential.serverURL.absoluteString)
                }
                Section("You") {
                    LabeledContent("Signed in as", value: whoami?.name ?? whoami?.id ?? "—")
                    LabeledContent("Credential expires", value: credential.expiresAt, format: .dateTime)
                }
                Section {
                    Button("Sign out", role: .destructive) { session.signOut() }
                }
            }
            .navigationTitle("Settings")
            .task {
                guard let client = session.client else { return }
                whoami = try? await client.whoami()
            }
        }
    }
}
#endif
