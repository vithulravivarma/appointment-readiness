# Handoff Cleanup Plan

## Goal
Prepare a clean, minimal, accurate repository for external handoff as a zip file.

## Audit Snapshot (2026-03-12)
- Repository currently has many local changes in progress (`git status` is not clean).
- README delegation flow now points to `/agents/:userId/command` for starts; keep this aligned with backend behavior.
- Legacy compatibility code still exists in appointment management:
  - legacy assistant-history fallback for Agent Desk history
  - deprecated delegation start endpoint retained as compatibility stub
- Docs include planning/working files that may not belong in final handoff package (`docs/todo.md`, phase-specific QA/spec docs).
- Local/dev artifacts exist in workspace (Excel files, local node_modules), but `.gitignore` already excludes them.

## Cleanup Strategy

### Phase 1: Freeze and Baseline
1. Create a cleanup branch.
2. Run baseline checks:
   - `npm test`
   - `npm run type-check --prefix services/appointment-management-service`
   - `npm run type-check --prefix services/readiness-engine`
3. Record current API surface (exported routes + docs links) before deleting anything.

### Phase 2: Remove Unused/Legacy Code (Controlled)
1. Identify dead TS exports/usages:
   - `npx ts-prune -p services/appointment-management-service/tsconfig.json`
   - `npx ts-prune -p services/ai-interpreter/tsconfig.json`
2. Identify unused dependencies:
   - `npx depcheck`
   - `npm prune`
3. Remove compatibility paths only after verification:
   - Agent Desk legacy history fallback (`legacy-assistant-history`) if `agent_desk_*` persistence is guaranteed in handoff target.
   - Deprecated `/agents/:userId/delegations/start` endpoint if no external callers require compatibility.
4. Re-run tests/type-checks after each removal batch.

### Phase 3: Documentation Cleanup
1. Keep only docs needed for operation + architecture + debugging.
2. Update README to match current behavior:
   - remove manual start endpoint usage examples
   - point delegation-start flow to `/agents/:userId/command`
3. Archive or remove internal planning docs from handoff package:
   - `docs/todo.md`
   - `docs/escalation-phase5-qa-checklist.md` (if no longer needed)
   - `docs/escalation-system-implementation-spec.md` (if no longer needed externally)
4. Ensure one source of truth per topic:
   - architecture
   - local runbook
   - AI workflow/debugging
   - AWS/production ops

### Phase 4: Handoff Packaging
1. Ensure secrets are not included:
   - no `.env`
   - no credentials in docs
2. Ensure no heavy/generated artifacts:
   - exclude `node_modules`, `dist`, logs, caches, Excel samples unless explicitly required.
3. Build handoff zip:
   - `zip -r appointment-readiness-handoff.zip . -x \"*/node_modules/*\" -x \"*/dist/*\" -x \"*.log\" -x \".env\" -x \"Appointment*.xlsx\" -x \"Staff*.xlsx\"`
4. Include a `HANDOFF.md` (or README section) with:
   - prerequisites
   - startup steps
   - known limitations
   - test/smoke commands
   - operational ownership notes

## Recommended Final Docs Set
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/agent-routing-architecture.md`
- `docs/ai-agentic-workflows.md`
- `docs/precheck-logic.md`
- `docs/aws-architecture-utilization-and-workflows.md`
- `docs/whatsapp-production-runbook.md` (if WhatsApp is in scope for handoff)

## Exit Criteria (Ready To Hand Off)
- `git status` clean.
- Tests and type-check pass.
- No known deprecated flow documented as primary.
- Handoff zip excludes secrets and local artifacts.
- One concise runbook path for local startup and production concept.
