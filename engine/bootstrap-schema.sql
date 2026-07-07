-- Agentlas 첫 실행 부트스트랩 스키마 (생성: 2026-07-07T03:05:25Z)
-- 소스 DB user_version=45 — 앱이 나중에 설치되면 여기서부터 마이그레이션한다.
PRAGMA user_version=45;
CREATE TABLE active_runtime (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        kind TEXT NOT NULL
      , backend TEXT, source TEXT, model TEXT, long_context INTEGER NOT NULL DEFAULT 0);
CREATE TABLE installed_agents (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        mcp_servers_json TEXT NOT NULL,
        preferred_backend TEXT,
        trust_grade TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        tone TEXT NOT NULL
      , env_requirements_json TEXT NOT NULL DEFAULT '[]', name_en TEXT NOT NULL DEFAULT '', tagline_en TEXT NOT NULL DEFAULT '', builtin INTEGER NOT NULL DEFAULT 0, role TEXT, visibility TEXT NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible','background','private')), entity_kind TEXT);
CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        default_agent_id TEXT,
        context_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, folder_path TEXT,
        FOREIGN KEY(default_agent_id) REFERENCES installed_agents(id) ON DELETE SET NULL
      );
CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '새 채팅',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, firm_id TEXT REFERENCES firms(id) ON DELETE SET NULL, archived_at TEXT, working_folder TEXT, kind TEXT NOT NULL DEFAULT 'user', parent_chat_id TEXT, used_at TEXT, agent_group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL, continuous_mode INTEGER NOT NULL DEFAULT 0, swarm_mode INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
CREATE INDEX idx_chats_updated ON chats(updated_at DESC);
CREATE INDEX idx_chats_project_updated
        ON chats(project_id, updated_at DESC);
CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
CREATE INDEX idx_chat_messages_chat_created
        ON chat_messages(chat_id, created_at);
CREATE TABLE firms (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL,
        persona TEXT NOT NULL,
        ceo_agent_id TEXT NOT NULL,
        org_chart_json TEXT NOT NULL,
        installed_at TEXT NOT NULL, name_en TEXT NOT NULL DEFAULT '', tagline_en TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(ceo_agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
CREATE INDEX idx_firms_installed ON firms(installed_at DESC);
CREATE INDEX idx_chats_firm_updated ON chats(firm_id, updated_at DESC);
CREATE INDEX idx_chats_archived_updated ON chats(archived_at, updated_at DESC);
CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        catalog_id TEXT,
        name TEXT NOT NULL,
        name_en TEXT NOT NULL DEFAULT '',
        transport TEXT NOT NULL,
        command TEXT,
        args_json TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        env_keys_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_at TEXT NOT NULL
      );
CREATE TABLE agent_mcp_servers (
        agent_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        PRIMARY KEY (agent_id, server_id),
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      );
CREATE INDEX idx_agent_mcp_agent ON agent_mcp_servers(agent_id);
CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        project_id TEXT,
        project_path TEXT,
        agent_id TEXT,
        chat_id TEXT,
        confidence TEXT NOT NULL DEFAULT 'medium',
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        superseded_at TEXT,
        created_at TEXT NOT NULL
      , context_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX idx_memory_path ON memory_entries(project_path, superseded_at);
CREATE INDEX idx_memory_scope ON memory_entries(scope, superseded_at);
CREATE INDEX idx_memory_chat ON memory_entries(chat_id);
CREATE TABLE folder_activity (
        path TEXT PRIMARY KEY,
        visits INTEGER NOT NULL DEFAULT 0,
        activated_at TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
CREATE INDEX idx_chats_parent ON chats(parent_chat_id);
CREATE INDEX idx_memory_agent ON memory_entries(agent_id, superseded_at);
CREATE TABLE automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        prompt_template TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL DEFAULT 'user',
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL
      , graph_json TEXT, schedule_json TEXT, timezone TEXT, end_at TEXT, max_runs INTEGER, run_count INTEGER NOT NULL DEFAULT 0, trigger_type TEXT NOT NULL DEFAULT 'schedule', trigger_json TEXT, claimed_at TEXT, lease_owner TEXT, tool_mode TEXT NOT NULL DEFAULT 'auto', hub_mode TEXT NOT NULL DEFAULT 'hub-allowed');
CREATE INDEX idx_automations_due ON automations(enabled, next_run_at);
CREATE TABLE agent_apps (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        action_id TEXT,
        app_name TEXT NOT NULL,
        domain TEXT NOT NULL,
        layout TEXT NOT NULL,
        root_path TEXT NOT NULL,
        preview_path TEXT NOT NULL,
        setup_path TEXT NOT NULL,
        smoke_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scaffolded',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
      );
CREATE INDEX idx_agent_apps_chat_updated
        ON agent_apps(chat_id, updated_at DESC);
CREATE INDEX idx_agent_apps_surface
        ON agent_apps(chat_id, surface_id, updated_at DESC);
CREATE UNIQUE INDEX idx_agent_apps_root
        ON agent_apps(root_path);
CREATE TABLE agent_app_operations (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(app_id) REFERENCES agent_apps(id) ON DELETE CASCADE
      );
CREATE INDEX idx_agent_app_ops_app_created
        ON agent_app_operations(app_id, created_at DESC);
CREATE TABLE agent_tools (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        action_id TEXT,
        requested_tool_id TEXT NOT NULL,
        generated_tool_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        domain TEXT NOT NULL,
        kind TEXT NOT NULL,
        root_path TEXT NOT NULL,
        config_path TEXT NOT NULL,
        tool_path TEXT NOT NULL,
        mcp_path TEXT NOT NULL,
        smoke_path TEXT NOT NULL,
        result_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scaffolded',
        installed_server_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(installed_server_id) REFERENCES mcp_servers(id) ON DELETE SET NULL
      );
CREATE INDEX idx_agent_tools_chat_updated
        ON agent_tools(chat_id, updated_at DESC);
CREATE INDEX idx_agent_tools_surface
        ON agent_tools(chat_id, surface_id, requested_tool_id, updated_at DESC);
CREATE UNIQUE INDEX idx_agent_tools_root
        ON agent_tools(root_path);
CREATE TABLE agent_tool_operations (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(tool_id) REFERENCES agent_tools(id) ON DELETE CASCADE
      );
CREATE INDEX idx_agent_tool_ops_tool_created
        ON agent_tool_operations(tool_id, created_at DESC);
CREATE TABLE agent_surfaces (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        domain TEXT NOT NULL,
        layout TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        state_json TEXT NOT NULL DEFAULT '{}',
        provenance_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
      );
CREATE INDEX idx_agent_surfaces_chat_updated
        ON agent_surfaces(chat_id, updated_at DESC);
CREATE INDEX idx_agent_surfaces_domain_updated
        ON agent_surfaces(domain, updated_at DESC);
CREATE INDEX idx_agent_surfaces_project_updated
        ON agent_surfaces(project_id, updated_at DESC);
CREATE TABLE agent_surface_asset_packs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        action_id TEXT,
        pack_name TEXT NOT NULL,
        domain TEXT NOT NULL,
        layout TEXT NOT NULL,
        root_path TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        index_path TEXT NOT NULL,
        assets_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'materialized',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(surface_id) REFERENCES agent_surfaces(id) ON DELETE CASCADE
      );
CREATE INDEX idx_agent_surface_asset_packs_chat_updated
        ON agent_surface_asset_packs(chat_id, updated_at DESC);
CREATE INDEX idx_agent_surface_asset_packs_surface_updated
        ON agent_surface_asset_packs(chat_id, surface_id, updated_at DESC);
CREATE UNIQUE INDEX idx_agent_surface_asset_packs_root
        ON agent_surface_asset_packs(root_path);
CREATE TABLE agent_surface_asset_pack_operations (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES agent_surface_asset_packs(id) ON DELETE CASCADE
      );
CREATE INDEX idx_agent_surface_asset_pack_ops_pack_created
        ON agent_surface_asset_pack_operations(pack_id, created_at DESC);
CREATE TABLE agent_surface_jobs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        cost_estimate REAL,
        cost_spent REAL,
        currency TEXT,
        resumable INTEGER NOT NULL DEFAULT 0,
        manifest_job_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(surface_id) REFERENCES agent_surfaces(id) ON DELETE CASCADE,
        UNIQUE(surface_id, job_id)
      );
CREATE INDEX idx_agent_surface_jobs_chat_updated
        ON agent_surface_jobs(chat_id, updated_at DESC);
CREATE INDEX idx_agent_surface_jobs_surface_updated
        ON agent_surface_jobs(surface_id, updated_at DESC);
CREATE INDEX idx_agent_surface_jobs_status_updated
        ON agent_surface_jobs(status, updated_at DESC);
CREATE TABLE agent_surface_events (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        event_type TEXT NOT NULL,
        path TEXT NOT NULL,
        value_json TEXT NOT NULL,
        previous_value_json TEXT,
        label TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(surface_id) REFERENCES agent_surfaces(id) ON DELETE CASCADE
      );
CREATE INDEX idx_agent_surface_events_surface_created
        ON agent_surface_events(surface_id, created_at DESC);
CREATE INDEX idx_agent_surface_events_chat_created
        ON agent_surface_events(chat_id, created_at DESC);
CREATE INDEX idx_installed_agents_visibility ON installed_agents(visibility, installed_at DESC);
CREATE TABLE agent_surface_approvals (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        action_id TEXT,
        action_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(surface_id) REFERENCES agent_surfaces(id) ON DELETE CASCADE
      );
CREATE INDEX idx_agent_surface_approvals_surface_created
        ON agent_surface_approvals(surface_id, created_at DESC);
CREATE INDEX idx_agent_surface_approvals_scope_active
        ON agent_surface_approvals(surface_id, scope_key, revoked_at, created_at DESC);
CREATE TABLE chat_runtime_sessions (
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        session_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, kind),
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
CREATE TABLE agent_runtime_overrides (
        scope TEXT NOT NULL CHECK(scope IN ('agent','firm','division')),
        target_id TEXT NOT NULL,
        label TEXT,
        kind TEXT NOT NULL,
        backend TEXT,
        source TEXT,
        model TEXT,
        effort TEXT,
        long_context INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, target_id)
      );
CREATE INDEX idx_agent_runtime_overrides_updated
        ON agent_runtime_overrides(updated_at DESC);
CREATE TABLE persona_loop_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK(target_type IN ('agent','firm')),
        target_id TEXT NOT NULL,
        target_label TEXT NOT NULL,
        persona_label TEXT NOT NULL,
        cadence TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        transcript_json TEXT NOT NULL,
        FOREIGN KEY(automation_id) REFERENCES automations(id) ON DELETE CASCADE
      );
CREATE INDEX idx_persona_loop_runs_updated
        ON persona_loop_runs(updated_at DESC);
CREATE INDEX idx_persona_loop_runs_automation
        ON persona_loop_runs(automation_id);
CREATE INDEX idx_chats_used_updated ON chats(used_at, updated_at DESC);
CREATE TABLE agent_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        orchestrator_name TEXT NOT NULL,
        members_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE INDEX idx_agent_groups_updated
        ON agent_groups(updated_at DESC);
CREATE INDEX idx_chats_agent_group_updated ON chats(agent_group_id, updated_at DESC);
CREATE TABLE run_history (
        id TEXT PRIMARY KEY,
        automation_id TEXT,
        scheduled_for TEXT,
        ran_at TEXT,
        status TEXT,
        skipped_count INTEGER DEFAULT 0,
        error TEXT
      );
CREATE INDEX idx_run_history_automation ON run_history(automation_id);
CREATE TABLE automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT,
        started_at TEXT,
        status TEXT,
        node_states_json TEXT
      );
CREATE INDEX idx_automation_runs_auto
        ON automation_runs(automation_id, started_at);
CREATE TRIGGER agentlas_auto_cua_social_insert
AFTER INSERT ON automations
WHEN NEW.tool_mode = 'auto' AND (
  lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%reddit%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%instagram%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%threads%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%twitter%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%x.com%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%linkedin%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%facebook%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%tiktok%'
  OR (lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%browser%' AND lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%post%')
  OR (lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%web%' AND lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%login%')
  OR coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'') LIKE '%레딧%'
  OR coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'') LIKE '%인스타%'
  OR coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'') LIKE '%댓글%'
  OR coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'') LIKE '%게시%'
  OR coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'') LIKE '%로그인%'
)
BEGIN
  UPDATE automations SET tool_mode = 'computer-use' WHERE id = NEW.id;
END;
CREATE TRIGGER agentlas_auto_cua_social_update
AFTER UPDATE OF name, prompt_template, tool_mode ON automations
WHEN NEW.tool_mode = 'auto' AND (
  lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%reddit%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%instagram%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%threads%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%twitter%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%x.com%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%linkedin%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%facebook%'
  OR lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%tiktok%'
  OR (lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%browser%' AND lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%post%')
  OR (lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%web%' AND lower(coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'')) LIKE '%login%')
  OR coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'') LIKE '%레딧%'
  OR coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'') LIKE '%인스타%'
  OR coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'') LIKE '%댓글%'
  OR coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'') LIKE '%게시%'
  OR coalesce(NEW.name,'') || ' ' || coalesce(NEW.prompt_template,'') LIKE '%로그인%'
)
BEGIN
  UPDATE automations SET tool_mode = 'computer-use' WHERE id = NEW.id;
END;
CREATE TABLE agent_evolution_proposals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        proposal_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        target_path TEXT NOT NULL,
        before_hash TEXT NOT NULL,
        after_hash TEXT NOT NULL,
        before_content TEXT NOT NULL,
        after_content TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        source_json TEXT NOT NULL DEFAULT '{}',
        decision_note TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT,
        applied_at TEXT,
        measured_at TEXT,
        rolled_back_at TEXT
      );
CREATE INDEX idx_agent_evolution_agent_status
        ON agent_evolution_proposals(agent_id, status, updated_at DESC);
CREATE INDEX idx_agent_evolution_created
        ON agent_evolution_proposals(created_at DESC);
CREATE TABLE run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        chat_id TEXT,
        automation_id TEXT,
        node_id TEXT,
        agent_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(run_id, seq)
      );
CREATE INDEX idx_run_events_run_seq
        ON run_events(run_id, seq);
CREATE INDEX idx_run_events_ts
        ON run_events(ts DESC);
CREATE INDEX idx_run_events_automation
        ON run_events(automation_id, ts DESC);
CREATE TABLE failure_events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        ts TEXT NOT NULL,
        source TEXT NOT NULL,
        chat_id TEXT,
        automation_id TEXT,
        node_id TEXT,
        agent_id TEXT,
        error_code TEXT,
        error_message TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
CREATE INDEX idx_failure_events_ts
        ON failure_events(ts DESC);
CREATE INDEX idx_failure_events_run
        ON failure_events(run_id, ts DESC);
CREATE INDEX idx_failure_events_automation
        ON failure_events(automation_id, ts DESC);
CREATE TABLE telegram_bindings (
        id TEXT PRIMARY KEY,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('agent','firm','group')),
        target_id TEXT NOT NULL,
        telegram_chat_id TEXT,
        telegram_chat_title TEXT,
        bot_user_id INTEGER,
        bot_username TEXT,
        bot_display_name TEXT,
        chat_session_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        last_update_id INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_test_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , automation_report_enabled INTEGER NOT NULL DEFAULT 0, token_saved INTEGER NOT NULL DEFAULT 0, token_fingerprint TEXT);
CREATE INDEX idx_telegram_bindings_target
        ON telegram_bindings(target_kind, target_id);
CREATE INDEX idx_telegram_bindings_chat
        ON telegram_bindings(telegram_chat_id);
CREATE INDEX idx_telegram_bindings_enabled
        ON telegram_bindings(enabled, status);
CREATE TABLE hub_agent_bookmarks (
        slug TEXT PRIMARY KEY,
        entity_kind TEXT NOT NULL DEFAULT 'agent',
        listing_json TEXT NOT NULL,
        bookmarked_at TEXT NOT NULL
      );
CREATE INDEX idx_hub_agent_bookmarks_time
        ON hub_agent_bookmarks(bookmarked_at DESC);
CREATE INDEX idx_hub_agent_bookmarks_kind
        ON hub_agent_bookmarks(entity_kind, bookmarked_at DESC);
CREATE INDEX idx_telegram_bindings_automation_report
        ON telegram_bindings(automation_report_enabled, enabled, telegram_chat_id);
