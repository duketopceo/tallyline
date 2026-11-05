#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

private enum ProjectsMode: String, CaseIterable, Identifiable {
    case projects = "Projects"
    case roadmap = "Roadmap"
    var id: String { rawValue }
}

/// Projects and the roadmap, one segmented control apart.
struct ProjectsTab: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State private var mode: ProjectsMode = .projects
    @State private var path: [Project] = []
    @State private var query = ""
    @State private var showCreate = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @SceneStorage("selectedProjectId") private var selectedProjectId: String?

    private var workspace: WorkspaceModel { session.workspace }

    var body: some View {
        if sizeClass == .regular {
            NavigationSplitView {
                root.modifier(ProjectsToolbar(session: session, mode: $mode, showCreate: $showCreate))
            } detail: {
                if mode == .projects, let id = selectedProjectId, let project = workspace.projects.first(where: { $0.id == id }) {
                    NavigationStack {
                        ProjectDetailView(session: session, credential: credential, project: project)
                            .navigationDestination(for: Issue.self) { issue in
                                IssueDetailView(session: session, credential: credential, issue: issue)
                            }
                    }
                    .id(id)
                } else {
                    ContentUnavailableView("Select a project", systemImage: "square.stack.3d.up", description: Text("Pick one to see its issues."))
                }
            }
            .sheet(isPresented: $showCreate) { CreateProjectView(session: session, credential: credential) }
        } else {
            NavigationStack(path: $path) {
                root
                    .modifier(ProjectsToolbar(session: session, mode: $mode, showCreate: $showCreate))
                    .navigationDestination(for: Project.self) { project in
                        ProjectDetailView(session: session, credential: credential, project: project)
                    }
                    .navigationDestination(for: Issue.self) { issue in
                        IssueDetailView(session: session, credential: credential, issue: issue)
                    }
            }
            .sheet(isPresented: $showCreate) { CreateProjectView(session: session, credential: credential) }
        }
    }

    @ViewBuilder
    private var root: some View {
        Group {
            switch mode {
            case .projects:
                ProjectListView(session: session, projects: filtered, summary: workspace.summary, selection: sizeClass == .regular ? $selectedProjectId : nil, onCreate: { showCreate = true })
                    .searchable(text: $query, prompt: "Search projects")
            case .roadmap:
                RoadmapView(workspace: workspace) { project in
                    if sizeClass == .regular {
                        selectedProjectId = project.id
                        mode = .projects
                    } else {
                        path.append(project)
                    }
                }
            }
        }
        .navigationTitle(mode.rawValue)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var filtered: [Project] {
        let sorted = ProjectOrdering.sorted(workspace.projects)
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return sorted }
        return sorted.filter { $0.name.localizedCaseInsensitiveContains(q) }
    }
}

private struct ProjectsToolbar: ViewModifier {
    var session: SessionModel
    @Binding var mode: ProjectsMode
    @Binding var showCreate: Bool

    func body(content: Content) -> some View {
        content.toolbar {
            ProfileToolbarItem(session: session)
            ToolbarItem(placement: .principal) {
                Picker("View", selection: $mode.animation(Motion.standard)) {
                    ForEach(ProjectsMode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 260)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showCreate = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New project")
            }
        }
    }
}

/// Name a project and create it. Everything else takes the server's default.
struct CreateProjectView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var error: String?
    @State private var saving = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                TextField("Project name", text: $name)
                    .focused($focused)
                if let error { Text(error).foregroundStyle(Theme.urgent) }
            }
            .navigationTitle("New project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }
                        .disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .task { focused = true }
        }
        .presentationDetents([.medium])
    }

    private func create() async {
        guard let client = session.client else { return }
        saving = true
        defer { saving = false }
        do {
            _ = try await client.createProject(ws: credential.workspaceSlug, name: name.trimmingCharacters(in: .whitespacesAndNewlines))
            await session.workspace.refresh(client: client, workspaceSlug: credential.workspaceSlug)
            dismiss()
        } catch let APIClientError.http(_, _, message) {
            self.error = message ?? "The server could not create the project."
        } catch {
            self.error = "You're offline. Try again when you're back."
        }
    }
}
#endif
