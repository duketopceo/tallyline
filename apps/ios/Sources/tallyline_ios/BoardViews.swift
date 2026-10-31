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
        .onChange(of: AppRouter.shared.destination, initial: true) { _, destination in
            guard let destination else { return }
            section = HomeSection(destination)
            AppRouter.shared.destination = nil
        }
        .sheet(item: Binding(
            get: { AppRouter.shared.issueKey.map { OpenIssueKey(id: $0) } },
            set: { AppRouter.shared.issueKey = $0?.id }
        )) { item in
            NavigationStack {
                IssueLoaderView(session: session, credential: credential, key: item.id)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { AppRouter.shared.issueKey = nil }
                        }
                    }
            }
        }
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
struct OpenIssueKey: Identifiable {
    let id: String
}

struct IssueListView: View {
    var session: SessionModel
    let credential: DeviceCredential
    let state: IssueState?
    @State private var error: String?
    @State private var showCreate = false

    private var issues: [Issue] {
        session.offline.cachedIssues(workspaceSlug: credential.workspaceSlug, state: state)
    }

    var body: some View {
        NavigationStack {
            Group {
                if issues.isEmpty, let error {
                    ContentUnavailableView("Couldn't load", systemImage: "exclamationmark.triangle", description: Text(error))
                } else if issues.isEmpty {
                    ContentUnavailableView("Nothing here", systemImage: "checkmark", description: Text("No issues in this list."))
                } else {
                    List {
                        if error != nil || !session.offline.isOnline {
                            Label("Offline. Showing issues saved on this phone.", systemImage: "wifi.slash")
                                .font(.footnote)
                                .foregroundStyle(Theme.inkMuted)
                        }
                        ForEach(issues) { issue in
                            NavigationLink(value: issue) { IssueRow(issue: issue) }
                        }
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
        do {
            try await session.offline.syncIssues(workspaceSlug: credential.workspaceSlug)
            error = nil
        } catch let APIClientError.http(_, _, message) {
            self.error = message ?? "load failed"
        } catch {
            self.error = "You're offline"
        }
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
    @State private var pendingNote: String?

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
            if let pendingNote {
                Section { Label(pendingNote, systemImage: "tray.and.arrow.up").font(.callout).foregroundStyle(Theme.inkMuted) }
            }
            if let actionError {
                Section { Text(actionError).foregroundStyle(Theme.urgent).font(.callout) }
            }
        }
        .navigationTitle(issue.key)
        .task { await loadComments() }
    }

    private func patch(_ mutate: (inout IssuePatch) -> Void) async {
        var p = IssuePatch()
        mutate(&p)
        let before = issue
        issue = issue.applying(p)
        session.offline.applyLocally(issue)
        actionError = nil
        switch await session.offline.submit(.updateIssue(key: issue.key, patch: p), workspaceSlug: credential.workspaceSlug) {
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
            session.offline.applyLocally(before)
            actionError = reason
        }
    }

    private func review(_ decision: String) async {
        guard let client = session.client else { return }
        do { issue = try await client.reviewIssue(ws: credential.workspaceSlug, key: issue.key, decision: decision) }
        catch let APIClientError.http(_, _, m) { actionError = m ?? "review failed" }
        catch { actionError = "review failed" }
    }

    private func postComment() async {
        let body = draft
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
                if !teams.isEmpty { TeamMemory().teams = teams }
                teamId = TeamMemory().pick(from: teams)?.id ?? ""
            }
        }
    }

    private func create() async {
        let draft = IssueCreate(
            title: title, description: description.isEmpty ? nil : description,
            teamId: teamId, priority: priority
        )
        TeamMemory().teamId = teamId
        switch await session.offline.submit(.createIssue(draft), workspaceSlug: credential.workspaceSlug) {
        case .sent, .queued:
            // Queued drafts show in Settings > Outbox until they send.
            await onCreated()
            dismiss()
        case .rejected(let reason):
            error = reason
        }
    }
}

/// Writes saved on the phone that have not reached the server yet.
struct OutboxView: View {
    var offline: OfflineModel

    var body: some View {
        List {
            if offline.entries.isEmpty {
                ContentUnavailableView("All sent", systemImage: "checkmark.circle", description: Text("Changes made offline wait here until they send."))
            }
            ForEach(offline.entries) { entry in
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.operation.summary).font(.body)
                    switch entry.status {
                    case .pending:
                        Text(entry.attempts == 0 ? "Waiting to send" : "Retrying (\(entry.attempts) tries so far)")
                            .font(.caption).foregroundStyle(Theme.inkMuted)
                    case .failed(let reason):
                        Text(reason).font(.caption).foregroundStyle(Theme.urgent)
                    }
                }
                .swipeActions {
                    Button("Discard", role: .destructive) { Task { await offline.discard(entry.id) } }
                    Button("Retry") { Task { await offline.retry(entry.id) } }.tint(Theme.accent)
                }
                .contextMenu {
                    Button("Retry") { Task { await offline.retry(entry.id) } }
                    Button("Discard", role: .destructive) { Task { await offline.discard(entry.id) } }
                }
            }
        }
        .navigationTitle("Outbox")
        .refreshable { await offline.drain() }
    }
}

/// Workspace, device, sign-out.
struct SettingsView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State private var whoami: Whoami?
    @AppStorage("appearance") private var appearance = SilverLiningAppearance.system.rawValue

    private var outboxSummary: String {
        let all = session.offline.entries.count
        let failed = session.offline.failedCount
        if all == 0 { return "All sent" }
        return failed > 0 ? "\(all) waiting, \(failed) need you" : "\(all) waiting"
    }

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
                Section("Notifications") {
                    NavigationLink("Notifications") { NotificationSettingsView(push: .shared) }
                }
                Section("Sync") {
                    NavigationLink {
                        OutboxView(offline: session.offline)
                    } label: {
                        LabeledContent("Outbox", value: outboxSummary)
                    }
                }
                Section("You") {
                    LabeledContent("Signed in as", value: whoami?.name ?? whoami?.id ?? "—")
                    LabeledContent("Credential expires", value: credential.expiresAt, format: .dateTime)
                }
                Section {
                    Button("Sign out", role: .destructive) {
                        Task {
                            await PushCenter.shared.unregister()
                            session.signOut()
                        }
                    }
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
