#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// Top-level destinations. Order drives the Command-1...4 shortcuts.
enum HomeSection: String, CaseIterable, Identifiable, Hashable {
    case triage, issues, review, settings
    var id: String { rawValue }

    var title: String {
        switch self {
        case .triage: "Triage"
        case .issues: "Issues"
        case .review: "Review"
        case .settings: "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .triage: "tray"
        case .issues: "list.bullet"
        case .review: "checkmark.circle"
        case .settings: "gearshape"
        }
    }

    var shortcut: KeyEquivalent {
        switch self {
        case .triage: "1"
        case .issues: "2"
        case .review: "3"
        case .settings: "4"
        }
    }
}

/// Signed-in shell. Tabs on iPhone; a sidebar split view on iPad and in
/// wide multitasking, where Command-1...4 switch sections.
struct HomeView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var section: HomeSection = .triage

    var body: some View {
        Group {
            if sizeClass == .regular {
                NavigationSplitView {
                    List(HomeSection.allCases, selection: Binding(
                        get: { section },
                        set: { if let next = $0 { section = next } }
                    )) { item in
                        Label(item.title, systemImage: item.symbol).tag(item)
                    }
                    .navigationTitle(credential.workspaceName)
                } detail: {
                    sectionView(section)
                }
            } else {
                TabView(selection: $section) {
                    ForEach(HomeSection.allCases) { item in
                        sectionView(item)
                            .tabItem { Label(item.title, systemImage: item.symbol) }
                            .tag(item)
                    }
                }
            }
        }
        .tint(Theme.accent)
        .background { sectionShortcuts }
    }

    @ViewBuilder
    private func sectionView(_ item: HomeSection) -> some View {
        switch item {
        case .triage: IssueListView(session: session, credential: credential, state: .triage)
        case .issues: IssueListView(session: session, credential: credential, state: nil)
        case .review: ReviewQueueView(session: session, credential: credential)
        case .settings: SettingsView(session: session, credential: credential)
        }
    }

    /// Invisible buttons that carry the hardware-keyboard section shortcuts.
    private var sectionShortcuts: some View {
        ZStack {
            ForEach(HomeSection.allCases) { item in
                Button(item.title) { section = item }
                    .keyboardShortcut(item.shortcut, modifiers: .command)
            }
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
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
                Button { Task { await reload() } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .keyboardShortcut("r", modifiers: .command)
                .accessibilityLabel("Refresh")
                Button { showCreate = true } label: { Image(systemName: "plus") }
                    .keyboardShortcut("n", modifiers: .command)
                    .accessibilityLabel("New issue")
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
        case .urgent: Theme.urgent
        case .high: Theme.attention
        case .medium, .low: Theme.inkMuted
        case .none: Theme.inkSubtle
        }
    }
}

/// Four-point star marking agent-authored or agent-held work.
struct Glint: View {
    var size: CGFloat = 12

    var body: some View {
        GlintShape()
            .fill(Theme.glint)
            .frame(width: size, height: size)
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
                    Button("Post") { Task { await postComment() } }
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(draft.isEmpty)
                }
            }
            if let actionError {
                Section { Text(actionError).foregroundStyle(Theme.urgent).font(.callout) }
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
                    List(entries) { entry in
                        NavigationLink(value: entry) { ReviewRow(entry: entry) }
                    }
                }
            }
            .navigationTitle("Review")
            .navigationDestination(for: ReviewQueueEntry.self) { entry in
                IssueLoaderView(session: session, credential: credential, key: entry.key)
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

/// One review-queue row: the issue and which agent's session put it there.
struct ReviewRow: View {
    let entry: ReviewQueueEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(entry.key).font(.caption.monospaced()).foregroundStyle(Theme.inkSubtle)
                Glint()
                Text(entry.agentName).font(.caption).foregroundStyle(Theme.inkMuted)
            }
            Text(entry.title).font(.body).lineLimit(2)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Fetches an issue by key, then shows its detail.
struct IssueLoaderView: View {
    var session: SessionModel
    let credential: DeviceCredential
    let key: String
    @State private var issue: Issue?
    @State private var error: String?

    var body: some View {
        Group {
            if let issue {
                IssueDetailView(session: session, credential: credential, issue: issue)
            } else if let error {
                ContentUnavailableView("Could not load \(key)", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .task {
            guard let client = session.client else { return }
            do { issue = try await client.issue(ws: credential.workspaceSlug, key: key) }
            catch { self.error = error.localizedDescription }
        }
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
                if let error { Text(error).foregroundStyle(Theme.urgent) }
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
    @AppStorage("appearance") private var appearance = SilverLiningAppearance.system.rawValue

    var body: some View {
        NavigationStack {
            List {
                Section("Workspace") {
                    LabeledContent("Name", value: credential.workspaceName)
                    LabeledContent("Server", value: credential.serverURL.host ?? credential.serverURL.absoluteString)
                }
                Section("Appearance") {
                    Picker("Theme", selection: $appearance) {
                        ForEach(SilverLiningAppearance.allCases, id: \.rawValue) { option in
                            Text(option.label).tag(option.rawValue)
                        }
                    }
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
