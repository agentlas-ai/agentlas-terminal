-- Agentlas 첫 실행 부트스트랩 스키마 (생성: 2026-08-29T07:55:23Z)
--
-- ★생성물이다. 손으로 고치지 말고 재생성하라:
--     node scripts/gen-bootstrap-schema.cjs
--
-- 정본은 Desktop 의 마이그레이션 사다리(agentlas_desktop/electron/store/db.ts, SCHEMA_VERSION).
-- 이 파일은 그 사다리를 **빈 DB** 에 끝까지 돌린 결과의 덤프이므로, 터미널이 만든 DB 는
-- 처음부터 사다리 머리에 있다 — 데스크탑이 나중에 승급할 것이 남지 않는다.
PRAGMA user_version=105;
CREATE TABLE active_runtime (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        kind TEXT NOT NULL
      , backend TEXT, source TEXT, model TEXT, long_context INTEGER NOT NULL DEFAULT 0);
CREATE TABLE agent_app_operations (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(app_id) REFERENCES agent_apps(id) ON DELETE CASCADE
      );
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
CREATE TABLE agent_architecture_migrations (
      agent_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      architecture_version TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('applied','noop','failed')),
      changed INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, step_id)
    );
CREATE TABLE agent_asset_versions (
        agent_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        package_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
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
      , operation_json TEXT);
CREATE TABLE agent_evolution_receipts (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_path TEXT NOT NULL,
        version_before INTEGER NOT NULL,
        version_after INTEGER NOT NULL,
        target_hash_before TEXT NOT NULL,
        target_hash_after TEXT NOT NULL,
        package_hash_before TEXT NOT NULL,
        package_hash_after TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(proposal_id) REFERENCES agent_evolution_proposals(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        UNIQUE(proposal_id, action)
      );
CREATE TABLE agent_identity_map (
        -- CASCADE 다. 대응표는 **파생 데이터**이고 정본은 패키지의 agentId 다.
        -- RESTRICT 로 두면 에이전트 삭제가 6곳에서 막힌다 — 사용자 삭제, 중복정리 2곳,
        -- 설치 실패 롤백, One 멤버 생성 실패 롤백, 터미널 삭제. 롤백이 막히면
        -- "설치 실패"가 "설치 실패 + 복구 실패 + 유령 행"이 된다.
        local_id            TEXT PRIMARY KEY REFERENCES installed_agents(id) ON DELETE CASCADE,
        -- 이름을 agent_id 로 두면 agent-dedupe 의 컬럼명 스윕에 걸린다. 값이 달라
        -- 지금은 매칭이 0건이지만, 이름 우연에 기대는 구조 자체가 지뢰다.
        immutable_agent_id  TEXT NOT NULL,
        agent_version       INTEGER NOT NULL DEFAULT 1,
        -- package: 패키지 agentlas.json 에서 읽음 (정본)
        -- builtin-reserved: 앱에 구워진 에이전트 — 패키지가 없어 예약 네임스페이스를 쓴다
        -- minted-local: 출처가 없어 이 기기에서 발급 (다음에 패키지를 받으면 package 가 이긴다)
        mapping_source      TEXT NOT NULL,
        bound_at            TEXT NOT NULL
      );
CREATE TABLE agent_mcp_servers (
        agent_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        PRIMARY KEY (agent_id, server_id),
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
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
CREATE TABLE agent_surface_asset_pack_operations (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES agent_surface_asset_packs(id) ON DELETE CASCADE
      );
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
CREATE TABLE agent_tool_operations (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(tool_id) REFERENCES agent_tools(id) ON DELETE CASCADE
      );
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
CREATE TABLE agent_usage (
        agent_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        first_used_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0
      );
CREATE TABLE automation_approval_waits (
      automation_id      TEXT NOT NULL,
      node_id            TEXT NOT NULL,
      first_requested_at TEXT NOT NULL,
      PRIMARY KEY (automation_id, node_id)
    );
CREATE TABLE automation_eval_corrections (
      automation_id  TEXT NOT NULL,
      node_id        TEXT NOT NULL,
      subject_preview TEXT NOT NULL,
      corrected_verdict TEXT NOT NULL,
      note           TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL,
      PRIMARY KEY (automation_id, node_id, created_at)
    );
CREATE TABLE automation_graph_versions (
      id            TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      saved_at      TEXT NOT NULL,
      note          TEXT,
      node_count    INTEGER NOT NULL DEFAULT 0,
      graph_json    TEXT NOT NULL
    );
CREATE TABLE automation_node_approvals (
      automation_id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL,
      node_id       TEXT NOT NULL,
      decision      TEXT NOT NULL,
      decided_at    TEXT NOT NULL,
      decided_by    TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'once',
      PRIMARY KEY (automation_id, occurrence_id, node_id)
    );
CREATE TABLE automation_run_inputs (
      id            TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      requested_by  TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      consumed_at   TEXT,
      consumed_run_id TEXT
    );
CREATE TABLE automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT,
        started_at TEXT,
        last_activity_at TEXT,
        status TEXT,
        node_states_json TEXT,
        occurrence_id TEXT,
        graph_digest TEXT,
        checkpoint_json TEXT,
        resume_of_run_id TEXT
      , node_failures_json TEXT, resume_consumed_at TEXT);
CREATE TABLE automation_sessions (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('host','agent','firm','hub')),
        target_id TEXT NOT NULL,
        ledger_chat_id TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(automation_id, target_kind, target_id)
      );
CREATE TABLE automation_trigger_events (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('fs','chain','webhook','poll','command')),
        dedupe_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','claimed','delivered','parked')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        next_attempt_at TEXT NOT NULL,
        claim_owner TEXT,
        claimed_until TEXT,
        run_id TEXT,
        run_outcome TEXT CHECK(run_outcome IS NULL OR run_outcome IN
          ('ok','partial','error','skipped','blocked','needs_input')),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        FOREIGN KEY(automation_id) REFERENCES automations(id) ON DELETE CASCADE,
        UNIQUE(automation_id, trigger_kind, dedupe_key),
        CHECK(
          (status = 'claimed' AND claim_owner IS NOT NULL AND claimed_until IS NOT NULL) OR
          (status <> 'claimed' AND claim_owner IS NULL AND claimed_until IS NULL)
        ),
        CHECK((status = 'delivered' AND delivered_at IS NOT NULL) OR status <> 'delivered')
      );
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
      , graph_json TEXT, goal TEXT, schedule_json TEXT, timezone TEXT, end_at TEXT, max_runs INTEGER, run_count INTEGER NOT NULL DEFAULT 0, trigger_type TEXT NOT NULL DEFAULT 'schedule', trigger_json TEXT, claimed_at TEXT, lease_owner TEXT, tool_mode TEXT NOT NULL DEFAULT 'auto', hub_mode TEXT NOT NULL DEFAULT 'hub-allowed', execution_permission TEXT NOT NULL DEFAULT 'write' CHECK(execution_permission IN ('read','write')), target_version TEXT, runtime_selection_json TEXT, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, goal_id TEXT, attention_cleared_at TEXT);
CREATE TABLE borrowed_agent_career_runs (
        owner_scope_key TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK(entity_kind IN ('agent','team')),
        agent_definition_id TEXT NOT NULL,
        agent_release_id TEXT NOT NULL,
        component_id TEXT NOT NULL DEFAULT '',
        run_id_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(
          owner_scope_key, entity_kind, agent_definition_id,
          agent_release_id, component_id, run_id_hash
        ),
        FOREIGN KEY(
          owner_scope_key, entity_kind, agent_definition_id,
          agent_release_id, component_id
        )
          REFERENCES borrowed_agent_careers(
            owner_scope_key, entity_kind, agent_definition_id,
            agent_release_id, component_id
          )
          ON DELETE CASCADE
      );
CREATE TABLE "borrowed_agent_career_runs_v76_legacy" (
        owner_scope_key TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK(entity_kind IN ('agent','team')),
        slug TEXT NOT NULL,
        run_id_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(owner_scope_key, entity_kind, slug, run_id_hash),
        FOREIGN KEY(owner_scope_key, entity_kind, slug)
          REFERENCES "borrowed_agent_careers_v76_legacy"(owner_scope_key, entity_kind, slug)
          ON DELETE CASCADE
      );
CREATE TABLE borrowed_agent_careers (
        owner_scope_key TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK(entity_kind IN ('agent','team')),
        agent_definition_id TEXT NOT NULL,
        agent_release_id TEXT NOT NULL,
        component_id TEXT NOT NULL DEFAULT '',
        slug TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        first_used_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
        latest_runtime_json TEXT,
        name_en TEXT,
        name_ko TEXT,
        tagline_en TEXT,
        tagline_ko TEXT,
        PRIMARY KEY(
          owner_scope_key, entity_kind, agent_definition_id,
          agent_release_id, component_id
        )
      );
CREATE TABLE "borrowed_agent_careers_v76_legacy" (
        owner_scope_key TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK(entity_kind IN ('agent','team')),
        slug TEXT NOT NULL,
        first_used_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
        latest_runtime_json TEXT,
        name_en TEXT,
        name_ko TEXT,
        tagline_en TEXT,
        tagline_ko TEXT,
        PRIMARY KEY(owner_scope_key, entity_kind, slug)
      );
CREATE TABLE browser_action_logs (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        site TEXT,
        action TEXT NOT NULL,
        target TEXT,
        result TEXT,
        approval TEXT,
        meta TEXT
      );
CREATE TABLE browser_permissions (
        id TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        action_type TEXT NOT NULL,
        decision TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE browser_sessions (
        id TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'none',
        captured_at TEXT,
        note TEXT,
        FOREIGN KEY(site) REFERENCES browser_sites(site) ON DELETE CASCADE
      );
CREATE TABLE browser_sites (
        id TEXT PRIMARY KEY,
        site TEXT NOT NULL UNIQUE,
        label TEXT,
        username TEXT,
        has_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE capability_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capability TEXT NOT NULL,
      pattern TEXT,
      decision TEXT NOT NULL CHECK(decision IN ('allow','deny')),
      scope TEXT NOT NULL DEFAULT 'global',
      source TEXT NOT NULL DEFAULT 'chip',
      created_at TEXT NOT NULL,
      UNIQUE(capability, pattern, scope)
    );
CREATE TABLE chat_goal_contracts (
      goal_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      objective TEXT,
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','blocked','completed','cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
CREATE TABLE chat_message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
      sha256 TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
CREATE TABLE "chat_runtime_sessions" (
                chat_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                agent_id TEXT NOT NULL DEFAULT '',
                session_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                reported_output_tokens INTEGER,
                reported_input_tokens INTEGER,
                reported_cached_input_tokens INTEGER,
                PRIMARY KEY (chat_id, kind, agent_id),
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
              );
CREATE TABLE "chats" (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            title TEXT NOT NULL DEFAULT 'New chat',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            firm_id TEXT,
            archived_at TEXT,
            working_folder TEXT,
            kind TEXT NOT NULL DEFAULT 'user',
            parent_chat_id TEXT,
            used_at TEXT,
            continuous_mode INTEGER NOT NULL DEFAULT 0,
            swarm_mode INTEGER NOT NULL DEFAULT 0,
            last_viewed_at TEXT,
            hired_agents TEXT,
            origin_surface TEXT NOT NULL DEFAULT 'work',
            runtime_selection_json TEXT,
            goal_id TEXT,
            seat_id TEXT,
            agent_id TEXT, seat_label TEXT, seat_kind TEXT, participants_json TEXT,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
            FOREIGN KEY(seat_id) REFERENCES one_seats(id) ON DELETE CASCADE,
            FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE SET NULL
          );
CREATE TABLE experience_auto_intake_receipts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        pack_id TEXT,
        candidate_id TEXT,
        source_memory_hash TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('candidate-created','blocked','skipped')),
        memory_kind TEXT NOT NULL,
        reason_codes_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, run_id TEXT NULL, redaction_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE SET NULL,
        FOREIGN KEY(candidate_id) REFERENCES experience_candidates(id) ON DELETE SET NULL,
        UNIQUE(agent_id, source_memory_hash)
      );
CREATE TABLE experience_candidates (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        project_scope_key TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        source_memory_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        task_terms_json TEXT NOT NULL DEFAULT '[]',
        sensitivity TEXT NOT NULL
          CHECK(sensitivity IN ('public','internal','private')),
        confidence TEXT NOT NULL
          CHECK(confidence IN ('high','medium','low')),
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK(status IN ('candidate','promoted','rejected')),
        outcome_status TEXT NOT NULL DEFAULT 'unverified'
          CHECK(outcome_status IN ('unverified','attested','verified','failed')),
        public_safe INTEGER NOT NULL DEFAULT 0 CHECK(public_safe IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        promoted_at TEXT, auto_managed INTEGER NOT NULL DEFAULT 0 CHECK(auto_managed IN (0,1)), embedding_model TEXT, embedding_adapter TEXT, embedding_model_sha256 TEXT, embedding_content_hash TEXT, embedding_dimensions INTEGER, embedding_json TEXT, axis_version INTEGER NOT NULL DEFAULT 2, base_core_hash TEXT, module_set_hash TEXT,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        UNIQUE(pack_id, source_memory_id)
      );
CREATE TABLE experience_cloud_uploads (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        requested_visibility TEXT NOT NULL
          CHECK(requested_visibility IN ('private','public')),
        bundle_id TEXT NOT NULL,
        bundle_hash TEXT NOT NULL,
        canonical_bundle_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        remote_upload_id TEXT,
        remote_revision TEXT,
        remote_status TEXT NOT NULL
          CHECK(remote_status IN (
            'local-ready','saving-private','private-saved','requesting-verification',
            'verification-requested','verification-pending','verified-private',
            'public-active','conflict','offline','error','withdrawn','rejected'
          )),
        remote_error_code TEXT,
        remote_error_message TEXT,
        remote_receipt_json TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        UNIQUE(pack_id, bundle_hash, requested_visibility)
      );
CREATE TABLE experience_export_intents (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK(visibility IN ('private','public')),
        status TEXT NOT NULL DEFAULT 'local_intent' CHECK(status = 'local_intent'),
        manifest_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
CREATE TABLE experience_governance_relations (
          relation_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          pack_id TEXT NOT NULL,
          from_candidate_id TEXT NOT NULL,
          to_candidate_id TEXT NOT NULL,
          relation_type TEXT NOT NULL CHECK(relation_type IN ('supersedes','contradicts')),
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
          FOREIGN KEY(from_candidate_id) REFERENCES experience_candidates(id) ON DELETE CASCADE,
          FOREIGN KEY(to_candidate_id) REFERENCES experience_candidates(id) ON DELETE CASCADE,
          UNIQUE(from_candidate_id, to_candidate_id, relation_type)
        );
CREATE TABLE experience_lineage_events (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        release_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('promotion','export-intent')),
        base_package_hash TEXT NOT NULL,
        project_scope_key TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        item_ids_json TEXT NOT NULL DEFAULT '[]',
        task_bindings_json TEXT NOT NULL DEFAULT '[]',
        mcp_requirements_json TEXT NOT NULL DEFAULT '[]',
        evidence_bindings_json TEXT NOT NULL DEFAULT '[]',
        supersedes_release_id TEXT,
        source_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        UNIQUE(pack_id, release_id, event_type)
      );
CREATE TABLE experience_packs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        project_id TEXT,
        project_path TEXT,
        project_scope_key TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        base_package_hash TEXT,
        -- 2축 좌표. 몸통(코어) 해시가 신원이고 부품 목록 해시는 실행 무결성이다.
        -- axis_version 2 = 옛 한 축 기록, 3 = 두 축을 갖춘 기록. 상세는 REQUIRED_COLUMNS 주석.
        axis_version INTEGER NOT NULL DEFAULT 2,
        base_core_hash TEXT,
        module_set_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active','archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, mcp_requirements_json TEXT NOT NULL DEFAULT '[]', base_agent_definition_id TEXT, base_agent_release_id TEXT, base_package_hash_version TEXT, environment_profile_json TEXT, auto_managed INTEGER NOT NULL DEFAULT 0 CHECK(auto_managed IN (0,1)),
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
CREATE TABLE experience_promotion_receipts (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action = 'promote'),
        explicit_consent INTEGER NOT NULL CHECK(explicit_consent = 1),
        verification_status TEXT NOT NULL CHECK(verification_status IN ('attested','verified')),
        verification_method TEXT NOT NULL
          CHECK(verification_method IN ('user-attested','local-run-receipt','local-test-receipt')),
        evidence_hash TEXT NOT NULL,
        public_safe INTEGER NOT NULL CHECK(public_safe IN (0,1)),
        created_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        FOREIGN KEY(candidate_id) REFERENCES experience_candidates(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        UNIQUE(candidate_id, action)
      );
CREATE TABLE experience_public_projections (
        projection_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        base_package_hash TEXT NOT NULL
          CHECK(length(base_package_hash) = 64 AND base_package_hash NOT GLOB '*[^0-9a-f]*'),
        base_agent_definition_id TEXT NOT NULL,
        base_agent_release_id TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        source_bindings_json TEXT NOT NULL,
        source_snapshot_hash TEXT NOT NULL
          CHECK(length(source_snapshot_hash) = 64 AND source_snapshot_hash NOT GLOB '*[^0-9a-f]*'),
        title TEXT NOT NULL,
        instructions_json TEXT NOT NULL,
        task_signatures_json TEXT NOT NULL,
        environment_constraints_json TEXT NOT NULL,
        proposal_hash TEXT NOT NULL
          CHECK(length(proposal_hash) = 64 AND proposal_hash NOT GLOB '*[^0-9a-f]*'),
        privacy_issue_codes_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('proposal','confirmed')),
        confirmation_hash TEXT,
        confirmed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        CHECK(
          (status = 'proposal' AND confirmation_hash IS NULL AND confirmed_at IS NULL) OR
          (status = 'confirmed' AND length(confirmation_hash) = 64
            AND confirmation_hash NOT GLOB '*[^0-9a-f]*' AND confirmed_at IS NOT NULL)
        )
      );
CREATE TABLE "experience_relation_edges" (
                edge_id TEXT PRIMARY KEY,
                pack_id TEXT NOT NULL,
                from_node TEXT NOT NULL,
                to_node TEXT NOT NULL,
                edge_type TEXT NOT NULL
                  CHECK(edge_type IN (
                    'has_release','exact_base_binding','contains','applies_to_task',
                    'applies_in_environment','requires_mcp','supports_mcp',
                    'alternative_mcp','supported_by','supersedes','contradicts',
                    'similar_to','similar_by_tag'
                  )),
                project_scope_key TEXT NOT NULL,
                environment_key TEXT NOT NULL,
                base_package_hash TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                source_fingerprint TEXT NOT NULL,
                rebuilt_at TEXT NOT NULL,
                FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
                FOREIGN KEY(from_node) REFERENCES experience_relation_nodes(node_id) ON DELETE CASCADE,
                FOREIGN KEY(to_node) REFERENCES experience_relation_nodes(node_id) ON DELETE CASCADE
              );
CREATE TABLE experience_relation_index_state (
        scope_key TEXT PRIMARY KEY CHECK(scope_key = 'shared'),
        source_fingerprint TEXT NOT NULL,
        rebuilt_at TEXT NOT NULL,
        node_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL
      );
CREATE TABLE experience_relation_nodes (
        node_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        node_type TEXT NOT NULL
          CHECK(node_type IN ('Pack','Release','Item','TaskTag','Environment','MCPRequirement','EvidenceReceipt')),
        entity_ref TEXT NOT NULL,
        project_scope_key TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        base_package_hash TEXT NOT NULL,
        normalized_value TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        source_fingerprint TEXT NOT NULL,
        rebuilt_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        UNIQUE(pack_id, node_type, entity_ref)
      );
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
CREATE TABLE firms (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL,
        persona TEXT NOT NULL,
        ceo_agent_id TEXT NOT NULL,
        org_chart_json TEXT NOT NULL,
        installed_at TEXT NOT NULL, name_en TEXT NOT NULL DEFAULT '', tagline_en TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(ceo_agent_id) REFERENCES installed_agents(id) ON DELETE RESTRICT
      );
CREATE TABLE folder_activity (
        path TEXT PRIMARY KEY,
        visits INTEGER NOT NULL DEFAULT 0,
        activated_at TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
CREATE TABLE graph_run_journal (
      run_id   TEXT NOT NULL,
      seq      INTEGER NOT NULL,
      ts       TEXT NOT NULL,
      kind     TEXT NOT NULL,
      node_id  TEXT,
      payload_json TEXT,
      PRIMARY KEY (run_id, seq)
    );
CREATE TABLE hub_agent_bookmarks (
            workspace_id TEXT NOT NULL,
            slug TEXT NOT NULL,
            entity_kind TEXT NOT NULL DEFAULT 'agent',
            listing_json TEXT NOT NULL,
            bookmarked_at TEXT NOT NULL,
            server_updated_at TEXT,
            sync_state TEXT NOT NULL DEFAULT 'clean'
              CHECK(sync_state IN ('clean','pending_upsert','pending_delete')),
            last_sync_error TEXT,
            claim_workspace_id TEXT,
            PRIMARY KEY(workspace_id, entity_kind, slug)
          );
CREATE TABLE installed_agent_hub_bindings (
        installed_agent_id TEXT PRIMARY KEY,
        agent_definition_id TEXT NOT NULL,
        agent_release_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('hub-install','agent-cloud-restore')),
        bound_at TEXT NOT NULL,
        FOREIGN KEY(installed_agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        UNIQUE(agent_definition_id, agent_release_id, installed_agent_id)
      );
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
      , env_requirements_json TEXT NOT NULL DEFAULT '[]', name_en TEXT NOT NULL DEFAULT '', tagline_en TEXT NOT NULL DEFAULT '', builtin INTEGER NOT NULL DEFAULT 0, role TEXT, visibility TEXT NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible','background','private')), entity_kind TEXT, local_display_name TEXT, bookmarked_at TEXT NULL, parent_team_id TEXT NULL);
CREATE TABLE invocation_steers (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      original_run_id TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      request_json TEXT NOT NULL,
      workspace_binding_json TEXT,
      execution_context_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','draining','started','cancelled','failed')),
      drained_run_id TEXT,
      queued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
CREATE TABLE judgment_verdicts (
      kind          TEXT NOT NULL,
      signature     TEXT NOT NULL,
      verdict       TEXT NOT NULL,
      confidence    REAL NOT NULL DEFAULT 0,
      reason        TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL,
      last_hit_at   TEXT NOT NULL,
      hits          INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (kind, signature)
    );
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
CREATE TABLE memory_decisions (
        decision_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        candidate_index INTEGER NOT NULL CHECK(candidate_index >= 0),
        content_hash TEXT NOT NULL
          CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
        memory_kind TEXT NOT NULL,
        proposed_scope TEXT NOT NULL,
        resolved_scope TEXT NOT NULL,
        action TEXT NOT NULL
          CHECK(action IN ('written','deduped','redacted','session','discarded','deferred')),
        reason_code TEXT NOT NULL,
        target_memory_id TEXT,
        confidence TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        curator_mode TEXT NOT NULL
          CHECK(curator_mode IN ('semantic','policy','policy_fallback','read_only')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(ticket_id) REFERENCES memory_tickets(ticket_id) ON DELETE CASCADE,
        FOREIGN KEY(target_memory_id) REFERENCES memory_entries(id) ON DELETE SET NULL,
        UNIQUE(ticket_id, candidate_index)
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
      , context_json TEXT NOT NULL DEFAULT '{}', embedding_model TEXT, embedding_adapter TEXT, embedding_model_sha256 TEXT, embedding_content_hash TEXT, embedding_dimensions INTEGER, embedding_json TEXT);
CREATE TABLE memory_episodes (
        episode_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL UNIQUE,
        project_id TEXT,
        project_path_hash TEXT,
        agent_id TEXT,
        chat_id TEXT,
        summary TEXT,
        summary_hash TEXT,
        embedding_model TEXT,
        embedding_adapter TEXT,
        embedding_model_sha256 TEXT,
        embedding_content_hash TEXT,
        embedding_dimensions INTEGER,
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(ticket_id) REFERENCES memory_tickets(ticket_id) ON DELETE CASCADE,
        CHECK(project_path_hash IS NULL OR
          (length(project_path_hash) = 64 AND project_path_hash NOT GLOB '*[^0-9a-f]*')),
        CHECK(summary_hash IS NULL OR
          (length(summary_hash) = 64 AND summary_hash NOT GLOB '*[^0-9a-f]*'))
      );
CREATE TABLE memory_relation_edges (
        relation_id TEXT PRIMARY KEY,
        from_memory_id TEXT NOT NULL,
        to_memory_id TEXT NOT NULL,
        relation_type TEXT NOT NULL
          CHECK(relation_type IN ('similar_to','supersedes','contradicts')),
        score REAL,
        owner_scope_key TEXT NOT NULL,
        embedding_model TEXT,
        embedding_adapter TEXT,
        embedding_model_sha256 TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(from_memory_id) REFERENCES memory_entries(id) ON DELETE CASCADE,
        FOREIGN KEY(to_memory_id) REFERENCES memory_entries(id) ON DELETE CASCADE,
        CHECK(from_memory_id <> to_memory_id),
        CHECK(score IS NULL OR (score >= -1.0 AND score <= 1.0)),
        UNIQUE(from_memory_id, to_memory_id, relation_type)
      );
CREATE TABLE memory_tickets (
        ticket_id TEXT PRIMARY KEY,
        turn_key TEXT NOT NULL UNIQUE,
        turn_id TEXT,
        run_id TEXT,
        node_id TEXT,
        chat_id TEXT,
        agent_id TEXT,
        project_id TEXT,
        project_path_hash TEXT,
        emitter_status TEXT NOT NULL
          CHECK(emitter_status IN ('valid','empty','missing','malformed','read_only')),
        candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count >= 0),
        state TEXT NOT NULL DEFAULT 'received'
          CHECK(state IN ('received','completed','read_only','failed')),
        curator_mode TEXT NOT NULL DEFAULT 'policy'
          CHECK(curator_mode IN ('semantic','policy','policy_fallback','read_only')),
        curation_outcome TEXT NOT NULL DEFAULT 'no_candidates'
          CHECK(curation_outcome IN ('decided','no_candidates','malformed_output','curator_failed','read_only')),
        written_count INTEGER NOT NULL DEFAULT 0 CHECK(written_count >= 0),
        deduped_count INTEGER NOT NULL DEFAULT 0 CHECK(deduped_count >= 0),
        redacted_count INTEGER NOT NULL DEFAULT 0 CHECK(redacted_count >= 0),
        session_count INTEGER NOT NULL DEFAULT 0 CHECK(session_count >= 0),
        discarded_count INTEGER NOT NULL DEFAULT 0 CHECK(discarded_count >= 0),
        failure_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
CREATE TABLE model_role_members (
        role TEXT NOT NULL CHECK(role IN ('orchestrator','worker')),
        position INTEGER NOT NULL CHECK(position >= 1),
        kind TEXT NOT NULL,
        backend TEXT,
        source TEXT,
        model TEXT,
        effort TEXT,
        long_context INTEGER NOT NULL DEFAULT 0 CHECK(long_context IN (0,1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(role, position)
      );
CREATE TABLE model_roles (
        role TEXT PRIMARY KEY CHECK(role IN ('orchestrator','worker')),
        kind TEXT NOT NULL,
        backend TEXT,
        source TEXT,
        model TEXT,
        effort TEXT,
        long_context INTEGER NOT NULL DEFAULT 0 CHECK(long_context IN (0,1)),
        inherit INTEGER NOT NULL DEFAULT 0 CHECK(inherit IN (0,1)),
        updated_at TEXT NOT NULL,
        CHECK(role = 'worker' OR inherit = 0)
      );
CREATE TABLE one_artifact_bindings (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_version INTEGER NOT NULL,
      bound_task_version INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      manifest_id TEXT NOT NULL,
      artifact_ref TEXT NOT NULL,
      source_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      file_dev TEXT NOT NULL,
      file_ino TEXT NOT NULL,
      file_mtime_ns TEXT NOT NULL,
      file_ctime_ns TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, chat_id, run_id, manifest_id, artifact_ref)
    );
CREATE TABLE one_org_completion_cache (
      installed_agent_id TEXT PRIMARY KEY,
      run_id TEXT,
      summary_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
CREATE TABLE one_org_members (
      id TEXT PRIMARY KEY,
      agent_slug TEXT NOT NULL,
      installed_agent_id TEXT NOT NULL,
      display_name TEXT,
      icon TEXT NOT NULL DEFAULT 'one-puppy',
      sort_order INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL CHECK(source IN ('local','cloud','hub')),
      lease_expires_at TEXT,
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      status_kind TEXT NOT NULL DEFAULT 'new',
      -- PRD §4.33 — 스키마에 사람이 읽는 문구(그것도 한 언어)를 박지 않는다.
      -- 빈 값이면 투영이 로케일 표에서 "아직 맡은 일 없음 / No work assigned yet"을 만든다.
      status_line TEXT NOT NULL DEFAULT '',
      last_activity_at TEXT,
      pending_count INTEGER NOT NULL DEFAULT 0,
      pending_kind TEXT NOT NULL DEFAULT 'approval' CHECK(pending_kind IN ('approval','review','input')),
      unread_count INTEGER NOT NULL DEFAULT 0,
      unread_generation INTEGER NOT NULL DEFAULT 0,
      credit_state TEXT NOT NULL DEFAULT 'unknown' CHECK(credit_state IN ('ok','insufficient','unknown')),
      auto_select_tools INTEGER NOT NULL DEFAULT 1 CHECK(auto_select_tools IN (0,1)),
      collaboration_style TEXT NOT NULL DEFAULT 'default' CHECK(collaboration_style IN ('default','concise','warm','direct')),
      handover_note TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
CREATE TABLE one_seat_occupants (
        seat_id      TEXT NOT NULL REFERENCES one_seats(id) ON DELETE CASCADE,
        slot         INTEGER NOT NULL DEFAULT 0,
        agent_id     TEXT,
        display_name TEXT NOT NULL DEFAULT '',
        since        TEXT NOT NULL,
        until        TEXT,
        PRIMARY KEY (seat_id, slot, since)
      );
CREATE TABLE one_seats (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL CHECK(kind IN ('solo','group')),
        title       TEXT NOT NULL DEFAULT '',
        project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        archived_at TEXT
      , dissolved_at TEXT);
CREATE TABLE one_taskforces (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      member_agent_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
CREATE TABLE plugin_builder_sessions (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        slug TEXT,
        phase TEXT NOT NULL CHECK(phase IN ('interview','draft','verify','install','prove','discarded')),
        staging_dir TEXT,
        answers_json TEXT,
        gate_report_json TEXT,
        seed_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE project_agent_rent_allow (
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, slug)
    );
CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        default_agent_id TEXT,
        context_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, folder_path TEXT, system_prompt TEXT, agent_pool_json TEXT NOT NULL DEFAULT '[]', source_type TEXT NOT NULL DEFAULT 'local', source_ref TEXT,
        FOREIGN KEY(default_agent_id) REFERENCES installed_agents(id) ON DELETE SET NULL
      );
CREATE TABLE prompt_chat_start_intents (
      intent_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL UNIQUE,
      prompt_digest TEXT NOT NULL,
      seed_only INTEGER NOT NULL CHECK(seed_only IN (0,1)),
      created_at TEXT NOT NULL
    );
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
CREATE TABLE run_history (
        id TEXT PRIMARY KEY,
        automation_id TEXT,
        scheduled_for TEXT,
        ran_at TEXT,
        status TEXT,
        skipped_count INTEGER DEFAULT 0,
        error TEXT
      , outcome TEXT, outcome_reason TEXT, acknowledged_at TEXT);
CREATE TABLE task_agent_participants (
        task_id TEXT NOT NULL,
        agent_id TEXT,
        agent_slug TEXT NOT NULL,
        role TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(task_id, agent_slug),
        FOREIGN KEY(task_id)  REFERENCES tasks(id)            ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE SET NULL
      );
CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        project_id TEXT,
        firm_id TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        origin_chat_id TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(firm_id)    REFERENCES firms(id)    ON DELETE SET NULL
      );
CREATE TABLE taste_chip_workflows (
        workflow_id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        base_package_hash TEXT NOT NULL,
        base_agent_definition_id TEXT NOT NULL,
        base_agent_release_id TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        taste_style_id TEXT NOT NULL,
        release_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        rule_statement TEXT NOT NULL,
        axis TEXT NOT NULL,
        task_signature TEXT NOT NULL,
        contexts_json TEXT NOT NULL,
        generalization_hash TEXT NOT NULL,
        privacy_issue_codes_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('proposal','confirmed','moderation-pending','ab-ready','error')),
        confirmed_at TEXT,
        preview_grants_json TEXT,
        preview_names_json TEXT,
        preview_digests_json TEXT,
        preview_rights TEXT,
        remote_preview_asset_ids_json TEXT,
        remote_revision TEXT,
        remote_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, preview_provenance_json TEXT,
        FOREIGN KEY(draft_id) REFERENCES taste_draft_candidates(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
CREATE TABLE taste_draft_candidates (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        source_memory_id TEXT NOT NULL,
        source_memory_hash TEXT NOT NULL,
        project_scope_key TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        base_package_hash TEXT NOT NULL
          CHECK(length(base_package_hash) = 64 AND base_package_hash NOT GLOB '*[^0-9a-f]*'),
        base_agent_definition_id TEXT,
        base_agent_release_id TEXT,
        sensitivity TEXT NOT NULL
          CHECK(sensitivity IN ('public','internal','private')),
        confidence TEXT NOT NULL
          CHECK(confidence IN ('high','medium','low')),
        axis_candidates_json TEXT NOT NULL DEFAULT '[]',
        task_signatures_json TEXT NOT NULL DEFAULT '[]',
        evidence_state TEXT NOT NULL DEFAULT 'pairwise-required'
          CHECK(evidence_state = 'pairwise-required'),
        status TEXT NOT NULL DEFAULT 'observation'
          CHECK(status IN ('observation','rejected')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        UNIQUE(agent_id, source_memory_hash, base_package_hash)
      );
CREATE TABLE "telegram_bindings" (
        id TEXT PRIMARY KEY,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('agent','firm','one')),
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
        updated_at TEXT NOT NULL,
        automation_report_enabled INTEGER NOT NULL DEFAULT 0,
        token_saved INTEGER NOT NULL DEFAULT 0,
        token_fingerprint TEXT,
        designated_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        designated_graph_id TEXT,
        legacy_notice_at TEXT
      , seat_id TEXT);
CREATE INDEX idx_agent_app_ops_app_created
        ON agent_app_operations(app_id, created_at DESC);
CREATE INDEX idx_agent_apps_chat_updated
        ON agent_apps(chat_id, updated_at DESC);
CREATE UNIQUE INDEX idx_agent_apps_root
        ON agent_apps(root_path);
CREATE INDEX idx_agent_apps_surface
        ON agent_apps(chat_id, surface_id, updated_at DESC);
CREATE INDEX idx_agent_architecture_migrations_step
      ON agent_architecture_migrations(step_id, outcome);
CREATE INDEX idx_agent_evolution_agent_status
        ON agent_evolution_proposals(agent_id, status, updated_at DESC);
CREATE INDEX idx_agent_evolution_created
        ON agent_evolution_proposals(created_at DESC);
CREATE INDEX idx_agent_evolution_receipts_agent
        ON agent_evolution_receipts(agent_id, created_at DESC);
CREATE INDEX idx_agent_evolution_receipts_proposal
        ON agent_evolution_receipts(proposal_id, created_at ASC);
CREATE INDEX idx_agent_identity_map_agent ON agent_identity_map(immutable_agent_id);
CREATE INDEX idx_agent_identity_map_source ON agent_identity_map(mapping_source);
CREATE INDEX idx_agent_mcp_agent ON agent_mcp_servers(agent_id);
CREATE INDEX idx_agent_runtime_overrides_updated
        ON agent_runtime_overrides(updated_at DESC);
CREATE INDEX idx_agent_surface_approvals_scope_active
        ON agent_surface_approvals(surface_id, scope_key, revoked_at, created_at DESC);
CREATE INDEX idx_agent_surface_approvals_surface_created
        ON agent_surface_approvals(surface_id, created_at DESC);
CREATE INDEX idx_agent_surface_asset_pack_ops_pack_created
        ON agent_surface_asset_pack_operations(pack_id, created_at DESC);
CREATE INDEX idx_agent_surface_asset_packs_chat_updated
        ON agent_surface_asset_packs(chat_id, updated_at DESC);
CREATE UNIQUE INDEX idx_agent_surface_asset_packs_root
        ON agent_surface_asset_packs(root_path);
CREATE INDEX idx_agent_surface_asset_packs_surface_updated
        ON agent_surface_asset_packs(chat_id, surface_id, updated_at DESC);
CREATE INDEX idx_agent_surface_events_chat_created
        ON agent_surface_events(chat_id, created_at DESC);
CREATE INDEX idx_agent_surface_events_surface_created
        ON agent_surface_events(surface_id, created_at DESC);
CREATE INDEX idx_agent_surface_jobs_chat_updated
        ON agent_surface_jobs(chat_id, updated_at DESC);
CREATE INDEX idx_agent_surface_jobs_status_updated
        ON agent_surface_jobs(status, updated_at DESC);
CREATE INDEX idx_agent_surface_jobs_surface_updated
        ON agent_surface_jobs(surface_id, updated_at DESC);
CREATE INDEX idx_agent_surfaces_chat_updated
        ON agent_surfaces(chat_id, updated_at DESC);
CREATE INDEX idx_agent_surfaces_domain_updated
        ON agent_surfaces(domain, updated_at DESC);
CREATE INDEX idx_agent_surfaces_project_updated
        ON agent_surfaces(project_id, updated_at DESC);
CREATE INDEX idx_agent_tool_ops_tool_created
        ON agent_tool_operations(tool_id, created_at DESC);
CREATE INDEX idx_agent_tools_chat_updated
        ON agent_tools(chat_id, updated_at DESC);
CREATE UNIQUE INDEX idx_agent_tools_root
        ON agent_tools(root_path);
CREATE INDEX idx_agent_tools_surface
        ON agent_tools(chat_id, surface_id, requested_tool_id, updated_at DESC);
CREATE INDEX idx_automation_graph_versions ON automation_graph_versions(automation_id, saved_at DESC);
CREATE INDEX idx_automation_node_approvals_node ON automation_node_approvals(automation_id, node_id, decided_at);
CREATE INDEX idx_automation_run_inputs_pending ON automation_run_inputs(automation_id, consumed_at, created_at);
CREATE INDEX idx_automation_runs_auto
      ON automation_runs(automation_id, started_at);
CREATE INDEX idx_automation_runs_occurrence
      ON automation_runs(automation_id, occurrence_id, started_at);
CREATE INDEX idx_automation_sessions_owner
        ON automation_sessions(automation_id, updated_at DESC);
CREATE INDEX idx_automation_trigger_events_automation
          ON automation_trigger_events(automation_id, status, created_at);
CREATE INDEX idx_automation_trigger_events_due
          ON automation_trigger_events(status, next_attempt_at, created_at);
CREATE INDEX idx_automation_trigger_events_run
          ON automation_trigger_events(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_automations_due ON automations(enabled, next_run_at);
CREATE UNIQUE INDEX idx_borrowed_agent_careers_owner_memory
        ON borrowed_agent_careers(owner_scope_key, memory_key);
CREATE INDEX idx_borrowed_agent_careers_owner_recent
        ON borrowed_agent_careers(owner_scope_key, last_used_at DESC);
CREATE INDEX idx_browser_logs_ts ON browser_action_logs(ts DESC);
CREATE UNIQUE INDEX idx_browser_perm_site_action
        ON browser_permissions(site, action_type);
CREATE UNIQUE INDEX idx_browser_sessions_site ON browser_sessions(site);
CREATE INDEX idx_capability_grants_scope ON capability_grants(scope);
CREATE UNIQUE INDEX idx_chat_goal_contracts_active_chat
      ON chat_goal_contracts(chat_id)
      WHERE status = 'active';
CREATE INDEX idx_chat_message_attachments_message
      ON chat_message_attachments(message_id, created_at, id);
CREATE INDEX idx_chat_messages_chat_created
        ON chat_messages(chat_id, created_at);
CREATE INDEX idx_chats_archived_updated ON chats(archived_at, updated_at DESC);
CREATE INDEX idx_chats_firm_updated ON chats(firm_id, updated_at DESC);
CREATE INDEX idx_chats_parent ON chats(parent_chat_id);
CREATE INDEX idx_chats_project_updated
        ON chats(project_id, updated_at DESC);
CREATE INDEX idx_chats_seat_updated ON chats(seat_id, updated_at DESC);
CREATE INDEX idx_chats_updated ON chats(updated_at DESC);
CREATE INDEX idx_chats_used_updated ON chats(used_at, updated_at DESC);
CREATE INDEX idx_experience_auto_intake_agent_status
        ON experience_auto_intake_receipts(agent_id, status, created_at DESC);
CREATE INDEX idx_experience_auto_intake_run
          ON experience_auto_intake_receipts(agent_id, run_id)
          WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX idx_experience_auto_pack_exact
        ON experience_packs(agent_id, project_scope_key, environment_key, base_package_hash)
        WHERE auto_managed = 1 AND status = 'active';
CREATE INDEX idx_experience_candidates_pack
        ON experience_candidates(pack_id, created_at DESC);
CREATE INDEX idx_experience_candidates_retrieval
        ON experience_candidates(agent_id, project_scope_key, environment_key, status, outcome_status, updated_at DESC);
CREATE INDEX idx_experience_cloud_uploads_pack
        ON experience_cloud_uploads(pack_id, updated_at DESC);
CREATE INDEX idx_experience_cloud_uploads_recovery
        ON experience_cloud_uploads(remote_status, updated_at ASC);
CREATE UNIQUE INDEX idx_experience_cloud_uploads_remote
        ON experience_cloud_uploads(remote_upload_id)
        WHERE remote_upload_id IS NOT NULL;
CREATE INDEX idx_experience_export_intents_pack
        ON experience_export_intents(pack_id, created_at DESC);
CREATE INDEX idx_experience_governance_pack
          ON experience_governance_relations(pack_id, relation_type, created_at ASC);
CREATE INDEX idx_experience_lineage_pack_created
        ON experience_lineage_events(pack_id, created_at ASC, id ASC);
CREATE INDEX idx_experience_packs_agent_scope
        ON experience_packs(agent_id, project_scope_key, environment_key, updated_at DESC);
CREATE INDEX idx_experience_packs_core_axis
                  ON experience_packs(agent_id, project_scope_key, environment_key, base_core_hash);
CREATE INDEX idx_experience_public_projection_agent_status
        ON experience_public_projections(agent_id, status, updated_at DESC);
CREATE INDEX idx_experience_public_projection_exact_base
        ON experience_public_projections(
          base_agent_definition_id, base_agent_release_id, base_package_hash, environment_key
        );
CREATE INDEX idx_experience_receipts_pack
        ON experience_promotion_receipts(pack_id, created_at DESC);
CREATE INDEX idx_experience_relation_edges_from
                ON experience_relation_edges(pack_id, from_node, edge_type);
CREATE INDEX idx_experience_relation_edges_scope
                ON experience_relation_edges(project_scope_key, environment_key, base_package_hash, edge_type);
CREATE INDEX idx_experience_relation_edges_to
                ON experience_relation_edges(pack_id, to_node, edge_type);
CREATE INDEX idx_experience_relation_nodes_pack_type
        ON experience_relation_nodes(pack_id, node_type, normalized_value);
CREATE INDEX idx_experience_relation_nodes_scope
        ON experience_relation_nodes(project_scope_key, environment_key, base_package_hash, node_type);
CREATE INDEX idx_failure_events_agent_ts ON failure_events(agent_id, ts DESC);
CREATE INDEX idx_failure_events_automation
        ON failure_events(automation_id, ts DESC);
CREATE INDEX idx_failure_events_run
        ON failure_events(run_id, ts DESC);
CREATE INDEX idx_failure_events_ts
        ON failure_events(ts DESC);
CREATE INDEX idx_firms_installed ON firms(installed_at DESC);
CREATE INDEX idx_graph_run_journal_run ON graph_run_journal(run_id, seq);
CREATE INDEX idx_hub_agent_bookmarks_outbox
          ON hub_agent_bookmarks(workspace_id, sync_state, bookmarked_at ASC);
CREATE INDEX idx_hub_agent_bookmarks_workspace_time
          ON hub_agent_bookmarks(workspace_id, bookmarked_at DESC);
CREATE INDEX idx_installed_agent_hub_binding_exact
        ON installed_agent_hub_bindings(agent_definition_id, agent_release_id);
CREATE INDEX idx_installed_agents_parent_team ON installed_agents(parent_team_id) WHERE parent_team_id IS NOT NULL;
CREATE INDEX idx_installed_agents_visibility ON installed_agents(visibility, installed_at DESC);
CREATE INDEX idx_invocation_steers_chat
      ON invocation_steers(chat_id, queued_at, id);
CREATE INDEX idx_invocation_steers_queue
      ON invocation_steers(status, queued_at, id);
CREATE INDEX idx_judgment_verdicts_recency ON judgment_verdicts(last_hit_at);
CREATE INDEX idx_memory_agent ON memory_entries(agent_id, superseded_at);
CREATE INDEX idx_memory_chat ON memory_entries(chat_id);
CREATE INDEX idx_memory_decisions_ticket_action
        ON memory_decisions(ticket_id, action, candidate_index);
CREATE INDEX idx_memory_episodes_agent_created
        ON memory_episodes(agent_id, created_at DESC);
CREATE INDEX idx_memory_episodes_project_created
        ON memory_episodes(project_id, created_at DESC);
CREATE INDEX idx_memory_episodes_project_path_created
        ON memory_episodes(project_path_hash, created_at DESC);
CREATE INDEX idx_memory_path ON memory_entries(project_path, superseded_at);
CREATE INDEX idx_memory_relation_from
        ON memory_relation_edges(from_memory_id, relation_type, score DESC);
CREATE INDEX idx_memory_relation_owner
        ON memory_relation_edges(owner_scope_key, relation_type, score DESC);
CREATE INDEX idx_memory_relation_to
        ON memory_relation_edges(to_memory_id, relation_type, score DESC);
CREATE INDEX idx_memory_scope ON memory_entries(scope, superseded_at);
CREATE INDEX idx_memory_tickets_agent_created
        ON memory_tickets(agent_id, created_at DESC);
CREATE INDEX idx_memory_tickets_project_created
        ON memory_tickets(project_id, created_at DESC);
CREATE INDEX idx_memory_tickets_status_created
        ON memory_tickets(emitter_status, state, created_at DESC);
CREATE INDEX idx_occupants_seat_time ON one_seat_occupants(seat_id, since);
CREATE INDEX idx_one_artifact_binding_chat
      ON one_artifact_bindings(chat_id, created_at);
CREATE INDEX idx_one_artifact_binding_exact
      ON one_artifact_bindings(task_id, chat_id, run_id, manifest_id, artifact_ref);
CREATE INDEX idx_one_org_members_agent
      ON one_org_members(installed_agent_id);
CREATE INDEX idx_one_org_members_order
      ON one_org_members(archived_at, sort_order, added_at);
CREATE INDEX idx_one_seats_updated ON one_seats(updated_at DESC);
CREATE INDEX idx_one_taskforces_updated
      ON one_taskforces(updated_at DESC);
CREATE INDEX idx_plugin_builder_sessions_chat_updated
        ON plugin_builder_sessions(chat_id, updated_at DESC);
CREATE INDEX idx_plugin_builder_sessions_slug_phase
        ON plugin_builder_sessions(slug, phase);
CREATE INDEX idx_prompt_chat_start_chat
      ON prompt_chat_start_intents(chat_id);
CREATE INDEX idx_run_events_agent_kind_ts
          ON run_events(agent_id, kind, ts DESC);
CREATE INDEX idx_run_events_agent_ts ON run_events(agent_id, ts DESC);
CREATE INDEX idx_run_events_automation
        ON run_events(automation_id, ts DESC);
CREATE INDEX idx_run_events_chat_kind_ts
          ON run_events(chat_id, kind, ts DESC);
CREATE INDEX idx_run_events_run_seq
        ON run_events(run_id, seq);
CREATE INDEX idx_run_events_ts
        ON run_events(ts DESC);
CREATE INDEX idx_run_history_automation ON run_history(automation_id);
CREATE INDEX idx_seat_occupants_agent
        ON one_seat_occupants(agent_id) WHERE agent_id IS NOT NULL;
CREATE UNIQUE INDEX idx_seat_occupants_current
        ON one_seat_occupants(seat_id, slot) WHERE until IS NULL;
CREATE INDEX idx_task_participants_agent ON task_agent_participants(agent_id);
CREATE INDEX idx_tasks_firm_updated ON tasks(firm_id, updated_at DESC);
CREATE INDEX idx_tasks_origin_chat ON tasks(origin_chat_id);
CREATE INDEX idx_tasks_project_updated ON tasks(project_id, updated_at DESC);
CREATE INDEX idx_tasks_updated ON tasks(updated_at DESC);
CREATE INDEX idx_taste_chip_workflows_agent_status
        ON taste_chip_workflows(agent_id, status, updated_at DESC);
CREATE INDEX idx_taste_drafts_agent_status
        ON taste_draft_candidates(agent_id, status, updated_at DESC);
CREATE INDEX idx_taste_drafts_exact_base
        ON taste_draft_candidates(agent_id, base_package_hash, project_scope_key, environment_key);
CREATE INDEX idx_telegram_bindings_automation_report
        ON telegram_bindings(automation_report_enabled, enabled, telegram_chat_id);
CREATE INDEX idx_telegram_bindings_chat
        ON telegram_bindings(telegram_chat_id);
CREATE INDEX idx_telegram_bindings_enabled
        ON telegram_bindings(enabled, status);
CREATE UNIQUE INDEX idx_telegram_bindings_one_room
        ON telegram_bindings(telegram_chat_id)
        WHERE target_kind = 'one' AND telegram_chat_id IS NOT NULL;
CREATE INDEX idx_telegram_bindings_target
        ON telegram_bindings(target_kind, target_id);
