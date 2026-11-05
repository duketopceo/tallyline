#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// The tabs. Settings is not one: it opens from the profile button.
enum AppTab: String, CaseIterable, Identifiable, Hashable {
    case now, issues, projects, review, search
    var id: String { rawValue }

    var title: String {
        switch self {
        case .now: "Now"
        case .issues: "Issues"
        case .projects: "Projects"
        case .review: "Review"
        case .search: "Search"
        }
    }

    var symbol: String {
        switch self {
        case .now: "sparkles"
        case .issues: "list.bullet"
        case .projects: "square.stack.3d.up"
        case .review: "checkmark.circle"
        case .search: "magnifyingglass"
        }
    }

    /// Command-number shortcut. Search has none of its own (Command-F is the
    /// system's).
    var shortcut: KeyEquivalent? {
        switch self {
        case .now: "1"
        case .issues: "2"
        case .projects: "3"
        case .review: "4"
        case .search: nil
        }
    }

    init(_ destination: PushDestination) {
        switch destination {
        case .now: self = .now
        case .myIssues, .settings: self = .issues
        case .projects, .roadmap: self = .projects
        case .review: self = .review
        }
    }
}

/// Which tab is up, and which sheets are showing. Shared with every tab's
/// toolbar through the environment.
@MainActor @Observable
final class ShellState {
    var tab: AppTab = .now
    var showSettings = false
    var showOutbox = false
}

/// Signed-in shell. One `TabView` serves iPhone and iPad: a bottom bar on
/// compact widths, a top bar with a sidebar toggle on regular ones. The search
/// tab sits at the trailing edge, and the agent pulse rides above the bar.
struct ShellView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State private var shell = ShellState()
    @Environment(\.scenePhase) private var scenePhase

    private var pulse: PulseSummary {
        let workspace = session.workspace
        let issues = session.offline.cachedIssues(workspaceSlug: credential.workspaceSlug, state: nil)
        let stale = workspace.fetchedAt.map { Date().timeIntervalSince($0) > NowFeed.staleAfter } ?? false
        return PulseSummary(
            agentsWorking: PulseSummary.agentsWorking(in: issues),
            inReview: workspace.review.count,
            waitingToSend: session.offline.entries.count,
            online: session.offline.isOnline,
            asOf: stale ? workspace.fetchedAt : nil
        )
    }

    var body: some View {
        TabView(selection: $shell.tab) {
            Tab(AppTab.now.title, systemImage: AppTab.now.symbol, value: AppTab.now) {
                NowView(session: session, credential: credential).modifier(PulseInset(pulse: pulse, onTap: openPulse))
            }
            Tab(AppTab.issues.title, systemImage: AppTab.issues.symbol, value: AppTab.issues) {
                IssueListView(session: session, credential: credential, state: nil).modifier(PulseInset(pulse: pulse, onTap: openPulse))
            }
            Tab(AppTab.projects.title, systemImage: AppTab.projects.symbol, value: AppTab.projects) {
                ProjectsTab(session: session, credential: credential).modifier(PulseInset(pulse: pulse, onTap: openPulse))
            }
            Tab(AppTab.review.title, systemImage: AppTab.review.symbol, value: AppTab.review) {
                ReviewQueueView(session: session, credential: credential).modifier(PulseInset(pulse: pulse, onTap: openPulse))
            }
            .badge(session.workspace.review.count)
            Tab(AppTab.search.title, systemImage: AppTab.search.symbol, value: AppTab.search, role: .search) {
                SearchView(session: session, credential: credential)
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .modifier(TabBarChrome(pulse: pulse, onTap: openPulse))
        .tint(Theme.accent)
        .environment(shell)
        .background { shortcuts }
        .task {
            await session.loadMe()
            await session.refresh()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await session.refresh() } }
        }
        .onChange(of: AppRouter.shared.destination, initial: true) { _, destination in
            guard let destination else { return }
            if destination == .settings {
                shell.showSettings = true
            } else {
                shell.tab = AppTab(destination)
            }
            AppRouter.shared.destination = nil
        }
        .sheet(isPresented: $shell.showSettings) {
            SettingsView(session: session, credential: credential)
        }
        .sheet(isPresented: $shell.showOutbox) {
            NavigationStack {
                OutboxView(offline: session.offline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) { Button("Done") { shell.showOutbox = false } }
                    }
            }
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

    private func openPulse() {
        switch pulse.tapTarget {
        case .review: shell.tab = .review
        case .outbox: shell.showOutbox = true
        }
    }

    /// Invisible buttons that carry the hardware-keyboard shortcuts, so the
    /// Command-key overlay on iPad lists them.
    private var shortcuts: some View {
        ZStack {
            ForEach(AppTab.allCases) { tab in
                if let key = tab.shortcut {
                    Button(tab.title) { shell.tab = tab }
                        .keyboardShortcut(key, modifiers: .command)
                }
            }
            Button("Settings") { shell.showSettings = true }
                .keyboardShortcut(",", modifiers: .command)
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }
}

/// iOS 26: the tab bar shrinks while scrolling and the pulse is the bar's
/// bottom accessory. Earlier systems keep the bar and use `PulseInset`.
private struct TabBarChrome: ViewModifier {
    let pulse: PulseSummary
    let onTap: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
                .tabBarMinimizeBehavior(.onScrollDown)
                .tabViewBottomAccessory { PulseBar(summary: pulse, action: onTap) }
        } else {
            content
        }
    }
}

/// Below iOS 26 the pulse sits just above the tab bar, inside each tab.
private struct PulseInset: ViewModifier {
    let pulse: PulseSummary
    let onTap: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                PulseBar(summary: pulse, action: onTap)
                    .background(.bar)
            }
        }
    }
}

/// The profile button every tab carries. Opens Settings.
struct ProfileToolbarItem: ToolbarContent {
    var session: SessionModel
    @Environment(ShellState.self) private var shell

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                shell.showSettings = true
            } label: {
                Text(Initials.from(session.me?.name))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .frame(minWidth: 28, minHeight: 28)
                    .background(Theme.surface3, in: Circle())
            }
            .accessibilityLabel("Settings")
        }
    }
}
#endif
