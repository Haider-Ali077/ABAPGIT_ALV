# SuperNova — Phase 1 Analysis (local working demo)

> Scope set by you: **working demo on a local machine only. No GitHub push, no cloud.** Everything below is shaped by that.
> No application code is written in this phase. Assumptions are tagged **[A-n]** and collected in §10.
> Companion file: [FSD-ZMM_LANDED_COST.md](FSD-ZMM_LANDED_COST.md) (deliverable 2, also the FSD template).

---

## 1. Reference repo: what was built

### 1.1 Files (all read in full)

| File | Lines | What it is |
|---|---|---|
| `.abapgit.xml` | 10 | Repo settings: `MASTER_LANGUAGE = E`, `STARTING_FOLDER = /src/`, `FOLDER_LOGIC = PREFIX`. No ignore list, no requirements block. |
| `README.md` | 42 | Report description, column-to-source table, selection screen, ALV behaviour, install steps (ZABAPGIT → New Online → package e.g. `$ZALV`). |
| `src/package.devc.xml` | 10 | Package (DEVC) with only `CTEXT = "ALV Reports (abapGit)"`. With PREFIX logic the package name comes from the root package chosen at import. |
| `src/zmm_landed_cost.prog.abap` | 493 | Report source. |
| `src/zmm_landed_cost.prog.xml` | 93 | PROGDIR (`SUBC=1` executable, `RLOAD=E`, `FIXPT=X`, `UCCHECK=X`) + TPOOL (title `R` + 13 selection texts `S`). |

Git history has two commits: `29891a1` (initial report) and `fdabad0` (labels fix). The fix matters: in v1 the select-options used DDIC selection texts (`ENTRY = "D       ."`) and block titles from text symbols (`ID = I`, `KEY = 001..003`). When the source was pasted into SE38 without the text pool, the screen showed technical names (`S_BUKRS`, `P_GR`). v2 moved every label into `SELECTION-SCREEN COMMENT ... FOR FIELD` lines filled in `INITIALIZATION`. **This defect was only visible in a real SAP GUI** — a static check would not have caught it. It is direct evidence for the risk in §8 that "looks right" ≠ "works in SAP".

### 1.2 What the report does

Landed cost per PO / scheduling-agreement item = material value (EKBE) + delivery costs (EKBZ) bucketed by condition type into Freight / Customs / Insurance / Other, plus cost per unit and DC %. Full functional detail is in the FSD (FR-01…FR-14).

### 1.3 Code structure (`src/zmm_landed_cost.prog.abap`)

| Lines | Element |
|---|---|
| 1–21 | Header comment block: purpose, sources, currency/unit rules |
| 24 | `TABLES: ekko, ekpo, ekbz` (only for `SELECT-OPTIONS ... FOR`) |
| 29–89 | Types: `ty_out` (22-column output), `ty_ekbe` / `ty_ekbz` with **full keys** as `SORTED ... NON-UNIQUE KEY ebeln ebelp`, `ty_coltext` |
| 103–175 | Selection screen: 3 framed blocks, every field in `BEGIN OF LINE` with `COMMENT 1(31)` label |
| 183–205 | `LCL_EVENTS` — `on_link_click` → ME23N (`BES`) / MM03 (`MAT`, skip first screen), both `WITH AUTHORITY-CHECK` |
| 210–236 | `INITIALIZATION`: block titles, labels, defaults `FRA1/FRB1/FRC1`, `ZOA1/ZOB1/ZOC1` |
| 241–251 | `START-OF-SELECTION`: `PERFORM get_data`, empty check, `PERFORM display_alv` |
| 256–366 | `FORM get_data`: one join EKKO/EKPO/T001/LFA1, two `FOR ALL ENTRIES` reads, signed aggregation, bucketing, derived columns, open-item filter |
| 371–493 | `FORM display_alv`: `CL_SALV_TABLE`, functions, layout save, column texts, currency/quantity refs, hotspots, sorts + subtotals, aggregations, header, 4 SALV exception types |

### 1.4 Conventions the Dev Agent must reproduce

| Convention | Observed |
|---|---|
| Object naming | `Z` + module (`MM`) + `_` + purpose → `ZMM_LANDED_COST` |
| Variables | `gt_` global table, `go_` global object, `lt_/ls_/lv_/lr_/lx_` locals, `<ls_...>` field symbols, `ty_/tt_` types, `s_` select-options, `p_` parameters, `c_` comments, `t_` block titles, `lcl_` local class |
| Style | Modern syntax (inline declarations, `VALUE #`, `COND #`, `@` escaping, `CAST`) **mixed with** classic `FORM` routines and event blocks |
| Comments | Section banners `*----*`, one comment line per logical step |
| abapGit file naming | `<object name lowercase>.<type>.<ext>` → `zmm_landed_cost.prog.abap` / `.prog.xml`; package in `package.devc.xml` |
| TPOOL format | Selection text `ENTRY` = 8 reserved chars + text; `LENGTH` = full entry length incl. the 8 chars (e.g. `"        Plant"` → 13). First char `D` means "take DDIC text". |
| XML envelope | `<abapGit version="v1.0.0" serializer="LCL_OBJECT_PROG" serializer_version="v1.0.0">` around `asx:abap` |

**Implication:** the platform should **not** let the LLM write the XML. The Dev Agent returns ABAP source + structured metadata (title, selection texts); a deterministic serializer writes `.prog.xml`, `package.devc.xml`, `.abapgit.xml`. The TPOOL length rule alone is easy for an LLM to get wrong.

### 1.5 Weaknesses in the reference (useful as Code Review test cases)

1. Scheduling agreements (`BSTYP = 'L'`, line 278) open in ME23N (line 198) — wrong transaction (FSD Q-1).
2. No `AUTHORITY-CHECK` on purchasing data (`M_BEST_*` / `M_RAHM_*`) (FSD Q-2).
3. `VGABE = '3'` subsequent debits ignored in "actual" mode (FSD Q-3).
4. Hard-coded English literals in `INITIALIZATION` — not translatable (FSD Q-7). A deliberate trade-off from `fdabad0`.
5. `FORM` routines are obsolete per SAP's ABAP programming guidelines (style, not a bug).
6. Only `S_BUKRS` mandatory — open-ended runs possible.

These are not reasons to change the golden repo; they are the **expected findings** when Code Review runs on it (milestone M5 acceptance test).

---

## 2. Reverse-engineered FSD

Delivered as a separate file: **[FSD-ZMM_LANDED_COST.md](FSD-ZMM_LANDED_COST.md)**. 16 sections, 14 numbered functional requirements (FR-01…FR-14), 22-column output spec, 7 open questions, 8 test scenarios.

How it becomes the platform template:
- Section headings + italic guidance = **template skeleton** (stored as JSON; see `FsdDocument` schema in §7.5).
- FR-nn IDs are the **traceability key** used by Validation (FSD ↔ code coverage) and by approvals (approver signs a specific FSD version hash).
- §4 selection table, §5 data sources and §7 output table are **structured**, not prose — the Data Analysis output fills them and the catalog checker validates them.

---

## 3. Diagram → repo: what each agent would have contributed

| Agent | Input it would have needed | Output for ZMM_LANDED_COST | Prompts needed |
|---|---|---|---|
| **Requirements Interviewer** | Free text: "report showing landed cost per PO item incl. freight/customs/insurance" | Structured requirement: cost basis GR vs IR (→ `P_GR`/`P_IR`), condition types per bucket with defaults, include scheduling agreements, exclude deleted items, include-open toggle, subtotals by company code/plant, drill-downs, layout variants. Plus the open questions it could not close (Q-1…Q-7). | `interviewer.system` (role, checklist per report type, max 3 questions/turn), `interviewer.checklist.alv_report`, `interviewer.summarize` |
| **SAP Functional Architect** | Structured requirement | Process validation: EKBZ holds *planned* delivery costs only (A-2); GR = accrual / IR = actual is correct split; flags VGABE 3 gap (Q-3); fit-gap vs standard (ME23N PO-history tab shows per document only, ME2N/ME80FN do not split delivery costs by type → custom report justified). | `functional_architect.system`, `functional_architect.fitgap` |
| **Data Analysis** | Requirement + SAP metadata catalog (tool access) | Tables EKKO, EKPO, T001, LFA1, EKBE, EKBZ; join keys; selection→field mapping (§4 of FSD); derived columns with formulas (FR-03…07); note to select full EKBE/EKBZ keys for FAE. | `data_analysis.system` + tools `search_catalog`, `get_table` |
| **Tech Architect** | Approved FSD + data map | 1 executable PROG, no DDIC/tcode; `CL_SALV_TABLE` + local event class; one join + 2 guarded FAE; sorted tables; labels in `INITIALIZATION`; package/naming; auth checks to add (Q-2). | `tech_architect.system`, `tech_architect.alv_report_pattern` |
| **FSD Generator** | Requirement + FA output + data map + template | The FSD document (as in the companion file) | `fsd_generator.system`, one prompt per template section group |
| **Validation** | FSD + generated artifact set + catalog | FR coverage matrix FR-01…14 → code locations; 0 unknown tables/fields; abaplint syntax clean; abapGit structure valid; label check (every selection field has a label — the `fdabad0` lesson encoded as a rule). | Mostly **deterministic**; one LLM prompt `validation.traceability` |
| **Dev** | Approved FSD + tech design + catalog subset + coding guidelines (+ findings on retry) | `zmm_landed_cost.prog.abap` + metadata JSON (title, selection texts) → serializer writes the rest | `dev.system`, `dev.guidelines`, `dev.fix_findings` |
| **Code Review** | Artifact set + checklist | Findings like §1.5 items 1–6, severity-ranked | `code_review.system`, `code_review.checklist` |

---

## 4. MVP scope (local demo)

### 4.1 Challenges to the proposed scope

| # | Proposed | Recommendation | Why |
|---|---|---|---|
| C-1 | Push to GitHub in abapGit format | **Replace** with: write abapGit folder to local disk + build a ZIP for **abapGit "New Offline" → Import ZIP**. Optional local `git init` + commit, never pushed. | Your local-only constraint. The ZIP route is how abapGit offline repos are loaded into SAP, so the hand-off to a real system stays realistic. |
| C-2 | One approval step | **Two gates**: FSD approval (Functional Approver) and code approval (Technical Consultant) before export. | Same state machine, one more transition (~0.5 day). Without it, LLM-written code leaves the platform with no human sign-off, which contradicts the diagram's Technical Consultant role. |
| C-3 | Live SAP connection OUT (fine) | **Add IN: local SAP metadata catalog** (curated DDIC subset: tables, fields, data elements, key flags, auth objects, tcodes, classes). | Without SAP and without a catalog, Data Analysis and Validation have nothing to check against — hallucinated fields would pass. This is the single most important addition. |
| C-4 | Code review/validation agent | Make Validation **mostly deterministic**: abaplint (syntax), catalog checker (tables/fields), serializer checks (abapGit format), naming rules. LLM only for FSD↔code traceability. | An LLM reviewing LLM code is weak evidence. Deterministic checks are cheap and repeatable. |
| C-5 | All object types implied | **Restrict to executable ALV reports (PROG) in MM.** | Catalog depth and validation rules scale with object types. One type done well proves the concept. |
| C-6 | Multi-LLM routing OUT | Keep OUT, but build the **provider interface + a mock/replay provider** in the MVP. | The replay provider makes the demo work offline and makes the golden test deterministic. It also proves the abstraction with two implementations. |
| C-7 | All 7 roles | **4 active roles + Auditor (read-only).** QA Engineer and Release Manager OUT. | No test execution or transports in a local demo, so those roles have nothing to do. |
| C-8 | "Generated ABAP must activate" | State honestly: **the local demo cannot prove activation.** It proves syntax-clean + catalog-grounded + structurally valid abapGit. Activation is a manual step (import ZIP into a sandbox) if you have one. | Avoids over-claiming in the demo. |

### 4.2 IN

1. Local login (seeded users), roles, permission matrix, separation of duties (author ≠ approver).
2. Requirement list/dashboard with status.
3. Requirement interview (chat, streamed) → structured requirement.
4. Functional Architect + Data Analysis passes, grounded on the local catalog.
5. FSD generation into the template; section-based editor; versioning; version diff.
6. Approval gate 1 (FSD) with comments; reject → back to draft.
7. Tech design + ABAP generation; deterministic abapGit serialization.
8. Validation (abaplint + catalog + structure + traceability) and Code Review; automatic fix loop (max 2 iterations); waivers with reason.
9. Approval gate 2 (code).
10. Export: local folder + abapGit offline ZIP download.
11. Audit log (hash-chained), agent run monitor (tokens, latency, errors), in-app notifications.
12. LLM provider interface: one real provider + mock/replay.
13. Golden test harness for ZMM_LANDED_COST.

### 4.3 OUT (mocked, stubbed or skipped)

| Item | Treatment |
|---|---|
| Live SAP (RFC/ADT), transports | Replaced by catalog; manual ZIP import |
| GitHub | Replaced by local folder/ZIP |
| Jira / Confluence / Email / Teams | Skipped; in-app notifications only |
| Kubernetes, cloud, backups | Skipped; `npm run dev` / single process |
| SSO | Skipped; local credentials |
| Multi-LLM routing | One provider + mock |
| QA test execution, ABAP Unit generation | Skipped; FSD keeps test scenarios as text |
| Encryption at rest | Skipped on local disk (flagged in §8) |
| DOCX/PDF FSD export | Skipped; Markdown export + browser print |
| Real-time co-editing | Skipped; optimistic locking on FSD versions |

---

## 5. Architecture and tech stack (local)

### 5.1 Shape

```
Browser (localhost:3000)
   │ HTTP + SSE (chat stream, run status)
   ▼
Next.js app — one Node process
 ├─ UI: dashboard, interview, FSD editor, approvals, code view, monitor, audit
 ├─ API: route handlers / server actions + RBAC guard
 ├─ Workflow service ── state machine (transition table, guards)
 ├─ Orchestrator ── in-process job runner, agent_runs table as queue
 │    ├─ agents/  (prompt files + Zod I/O schemas + handler)
 │    └─ llm/     LlmClient interface → AnthropicAdapter | OpenAIAdapter | ReplayAdapter
 ├─ Validation ── @abaplint/core · catalog checker · abapGit structure checker
 ├─ Serializer ── abapGit XML writer + ZIP
 └─ Audit / Notifications
   │                         │
 SQLite (data/supernova.db)   Local FS: data/artifacts/<REQ>/v<n>/, data/llm-replay/
   │
 External: one LLM API over HTTPS (none in replay mode)
```

### 5.2 Choices

| Concern | Choice | Reasoning | Alternative |
|---|---|---|---|
| Frontend | **Next.js (App Router) + React + Tailwind + shadcn/ui**; Monaco (read-only ABAP/XML viewer, diff); TipTap or Markdown editor per FSD section | One codebase with the backend; good component kit for dashboards/forms | Vite React SPA + separate API server |
| Backend | **Same Next.js process, TypeScript** | abaplint is a Node library → no second runtime; one `npm run dev` for the demo | Python FastAPI (better if your team is Python; costs a Node sidecar for abaplint) |
| DB | **SQLite + Drizzle ORM**, schema kept Postgres-compatible | Zero setup, file-based, easy to reset for demos | Postgres in Docker |
| Orchestration | **Hand-written typed pipeline** + explicit transition table; each agent = `(input) → validated output` | The flow is linear with one bounded loop (fix findings). A framework adds concepts without benefit at this size | LangGraph.js (worth it once flows branch or need human-in-the-loop interrupts mid-graph) |
| Background work | **In-process runner**, `agent_runs` rows as the queue, UI follows via SSE | Dev Agent runs take 30–120 s; must not block requests. No Redis needed locally | BullMQ + Redis |
| LLM abstraction | **Own `LlmClient` interface** (`generateObject(schema)`, `stream(messages)`), adapters built on the Vercel AI SDK provider packages; per-agent model in `settings` | Swap provider by config; structured output via Zod → JSON Schema; our interface keeps the SDK replaceable | LiteLLM proxy (Python, OpenAI-compatible endpoint) |
| Replay | **ReplayAdapter**: key = hash(agent, prompt_version, canonical input); record mode writes JSON fixtures | Offline demo, deterministic golden test, zero API cost in CI | VCR-style HTTP recording |
| ABAP syntax | **@abaplint/core** with `syntax.version` set to the target release and `errorNamespace = ^(Z|Y|LCL_|LIF_|TY_|TT_)` | Only offline ABAP parser/checker available. Standard objects (EKKO, CL_SALV_TABLE) become "void" types → no false errors | None comparable offline; real check needs SAP ADT |
| Field existence | **Own catalog checker** using abaplint's AST to extract `table~field`, `TYPE tab-field`, `FOR tab-field`, `FROM/JOIN tab` and checking them against the catalog | abaplint treats standard objects as void, so it cannot catch `EKBE-FOOBAR`. This closes that gap | Ship abapGit TABL stubs for catalog tables as abaplint dependencies (spike in M5) |
| abapGit output | **Deterministic serializer** (XML templates) + ZIP library | Format is mechanical; LLMs get lengths/escaping wrong | LLM writes XML + validator (rejected) |
| Auth | **Session cookie (iron-session or Auth.js credentials)**, bcrypt, seeded users per role | Simple, local, no external IdP | Auth.js + local Keycloak to rehearse SSO |
| Secrets | **`.env.local`** holds the LLM API key only; read server-side; redacted from logs and stored prompts; `SecretStore` interface for later | Demo has no SAP or GitHub credentials → no other secrets exist | OS keychain (keytar) |
| Files | Local FS, path + SHA-256 in DB | Simple, inspectable | MinIO |

**[A-6]** The app lives in its own folder (e.g. `D:\Projects\SuperNova`), not in this repo. This repo is copied in as the golden fixture.

---

## 6. Data model and workflow

### 6.1 Entities

| Table | Key columns | Notes |
|---|---|---|
| `users` | id, email, name, password_hash, active | Seeded |
| `user_roles` | user_id, role | role ∈ FUNC_CONSULTANT, FUNC_APPROVER, TECH_CONSULTANT, ADMIN, AUDITOR. M:N so one demo user can hold several |
| `requirements` | id, key (`REQ-0001`), title, module, object_type (`PROG_ALV`), proposed_object_name, status, created_by, tech_owner_id, current_fsd_version_id, current_artifact_set_id, row_version | Workflow anchor |
| `interview_messages` | id, requirement_id, seq, sender (user/agent), content, agent_run_id | Chat transcript |
| `requirement_specs` | id, requirement_id, version_no, spec_json, created_by_run_id | Structured requirement (Interviewer output) |
| `analysis_results` | id, requirement_id, kind (FUNCTIONAL/DATA/TECH), version_no, result_json, agent_run_id | FA, Data Analysis, Tech Architect outputs |
| `fsd_versions` | id, requirement_id, version_no, parent_version_id, content_json, content_hash, source (AGENT/HUMAN), created_by, created_at | Immutable; edits create new versions |
| `artifact_sets` | id, requirement_id, version_no, fsd_version_id, tech_design_id, iteration, status, folder_path, zip_path, zip_hash | One per Dev run; links code to the FSD version it came from |
| `artifacts` | id, artifact_set_id, path, object_type, object_name, content_hash, size | Files in the set |
| `findings` | id, target_type (FSD/ARTIFACT_SET), target_id, source (ABAPLINT/CATALOG/STRUCTURE/TRACE/REVIEW), severity (BLOCKER/ERROR/WARNING/INFO), rule, file, line, message, suggested_fix, status (OPEN/FIXED/WAIVED), waived_by, waiver_reason | Validation + review results |
| `approvals` | id, requirement_id, gate (FSD/CODE), target_id, target_hash, approver_id, decision, comment, decided_at | Signs an exact content hash |
| `agent_runs` | id, requirement_id, agent, prompt_version, provider, model, status (QUEUED/RUNNING/SUCCEEDED/FAILED), input_ref, output_json, error, attempt, tokens_in, tokens_out, latency_ms, started_at, finished_at | Queue + monitor |
| `catalog_tables` | name, description, delivery_class, release_min, release_max | e.g. KONV marked obsolete for S/4 |
| `catalog_fields` | table_name, field, position, key_flag, data_element, abap_type, length, decimals, description, ref_table, ref_field | Currency/unit refs included |
| `catalog_objects` | type (CLAS/TRAN/AUTH/FUNC/PARAM_ID), name, description, meta_json | CL_SALV_TABLE, ME23N, M_BEST_WRK, BES… |
| `audit_log` | id, ts, actor_id (or `system:agent`), action, entity_type, entity_id, details_json, prev_hash, hash | Append-only, hash-chained |
| `notifications` | id, user_id, requirement_id, type, message, read_at | In-app |
| `settings` | key, value_json | Model per agent, naming rules, target release, default package |

Relationships: `requirements` 1—N `interview_messages`, `requirement_specs`, `analysis_results`, `fsd_versions`, `artifact_sets`, `approvals`, `agent_runs`; `artifact_sets` 1—N `artifacts`, `findings`; `artifact_sets` N—1 `fsd_versions`; `approvals` → exactly one `fsd_versions` or `artifact_sets` row by `target_id` + `target_hash`.

### 6.2 Statuses and transitions

| From | To | Trigger | Who | Guard |
|---|---|---|---|---|
| — | `DRAFT` | Create requirement | FC | — |
| `DRAFT` | `INTERVIEW` | Start interview | FC | — |
| `INTERVIEW` | `ANALYSIS_RUNNING` | "Interview complete" | FC | Interviewer says `ready_for_fsd` **or** FC overrides with a reason (audited) |
| `ANALYSIS_RUNNING` | `FSD_DRAFT` | FA + Data Analysis + FSD Generator succeed | system | All three runs SUCCEEDED |
| `ANALYSIS_RUNNING` | `INTERVIEW` | Any run fails / catalog misses need answers | system | Failure reason shown |
| `FSD_DRAFT` | `FSD_DRAFT` | Edit section (new version) | FC | Optimistic lock on `row_version` |
| `FSD_DRAFT` | `FSD_IN_REVIEW` | Submit | FC | 0 open BLOCKER findings on FSD (unknown table/field, missing mandatory section) |
| `FSD_IN_REVIEW` | `FSD_APPROVED` | Approve | Approver | Approver ≠ creator and ≠ any author of the version; records `content_hash` |
| `FSD_IN_REVIEW` | `FSD_DRAFT` | Reject (comment mandatory) | Approver | — |
| `FSD_APPROVED` | `BUILD_RUNNING` | Start build | TC | — |
| `BUILD_RUNNING` | `CODE_IN_REVIEW` | Tech Architect → Dev → Validation → Code Review succeed with 0 open BLOCKER/ERROR (after ≤ 2 auto-fix loops) | system | — |
| `BUILD_RUNNING` | `BUILD_NEEDS_ATTENTION` | Still BLOCKER/ERROR after 2 loops, or a run fails | system | — |
| `BUILD_NEEDS_ATTENTION` | `BUILD_RUNNING` | Retry / waive findings and continue | TC | Waiver needs reason; BLOCKER cannot be waived |
| `BUILD_NEEDS_ATTENTION` / `CODE_IN_REVIEW` | `FSD_DRAFT` | Send back to functional (spec problem) | TC | Invalidates current artifact set |
| `CODE_IN_REVIEW` | `CODE_APPROVED` | Approve code | TC | 0 open BLOCKER/ERROR; records `zip_hash`. **[A-11]** Same TC may waive and approve in the demo; production should require a second TC |
| `CODE_IN_REVIEW` | `BUILD_RUNNING` | Request changes (comment → fed to Dev as finding) | TC | — |
| `CODE_APPROVED` | `EXPORTED` | Export | TC | Writes folder + ZIP; hashes must equal approved hash |
| any before `EXPORTED` | `CANCELLED` | Cancel | FC (own) / ADMIN | — |
| any after `FSD_APPROVED` | `FSD_DRAFT` | Edit approved FSD | FC | Creates new version, voids approval, invalidates artifacts (audited) |

Admin can reassign owners but cannot approve on someone's behalf. Auditor: read everything, change nothing.

### 6.3 Permission matrix (MVP)

| Action | FC | Approver | TC | Admin | Auditor |
|---|:-:|:-:|:-:|:-:|:-:|
| Create requirement, interview, edit FSD | ✔ | | | | |
| Approve/reject FSD | | ✔ | | | |
| Start build, waive findings, approve code, export | | | ✔ | | |
| View requirements, FSDs, code | ✔ | ✔ | ✔ | ✔ | ✔ |
| Manage users, settings, catalog | | | | ✔ | |
| View audit log, agent runs | | | | ✔ | ✔ |

---

## 7. Agent contracts

### 7.0 Common rules

- Every agent: versioned prompt file (`prompt_version`), Zod input/output schema, temperature ≤ 0.2, explicit max tokens.
- **Output handling:** provider structured-output / tool mode → Zod parse → on failure **one repair retry** with the validation error appended → else run `FAILED` with the raw output stored. No silent defaults.
- **Grounding rule:** any table, field, class, tcode, auth object or parameter ID mentioned in an output must exist in the catalog; otherwise it must be listed in `catalog_misses`, never used silently.
- **Timeouts:** 60 s (chat turn), 180 s (Dev). Transient provider errors (429/5xx): 2 retries with backoff.
- Every run writes `agent_runs` + `audit_log`.

Shared type used below:
```ts
type CatalogRef = { table: string; field?: string }
type Finding = { id: string; severity: "BLOCKER"|"ERROR"|"WARNING"|"INFO";
  category: string; rule: string; file?: string; line?: number;
  message: string; suggested_fix?: string; fr_ids?: string[] }
```

### 7.1 Requirements Interviewer
- **Prompt outline:** SAP functional consultant persona · goal: fill the checklist for `PROG_ALV` (purpose, users, selection fields + mandatory, data/measures, business rules, grouping/totals, drill-downs, currency/unit, authorizations, volume, out-of-scope) · max 3 questions per turn, offer options when the domain has standard answers (e.g. GR vs IR basis) · never name tables unless the user did · summarize back before marking ready.
- **Input:** `{ requirement_id, initial_text, transcript: {sender, content}[], current_spec?: RequirementSpec }`
- **Output:**
```json
{ "reply": "string",
  "questions": [{ "id": "q1", "text": "string", "why": "string", "options": ["string"] }],
  "spec_patch": "Partial<RequirementSpec>",
  "coverage": { "purpose": true, "selection": true, "measures": false, "rules": false,
                "output": false, "drilldown": false, "auth": false, "volume": false },
  "ready_for_fsd": false }
```
`RequirementSpec = { title, purpose, module, object_type, users, selection_criteria[{name, description, mandatory, multiple, default?}], measures[{name, definition}], rules[string], grouping[{field, subtotal}], drilldowns[{field, target}], currency_rule, volume, auth_notes, out_of_scope[], assumptions[], open_questions[] }`
- **Failure:** schema failure → repair retry → else show "agent could not respond, retry"; the transcript is kept. `ready_for_fsd` with uncovered items → platform refuses unless FC overrides.

### 7.2 SAP Functional Architect
- **Prompt outline:** senior MM/FI consultant · check each rule against standard SAP process · name standard alternatives (fit-gap) · flag missing business cases (reversals, credit memos, subsequent debits, multiple account assignment, currencies).
- **Input:** `{ spec: RequirementSpec, catalog_summary: {module, tcodes[], tables[]} }`
- **Output:**
```json
{ "rule_checks": [{ "rule": "string", "verdict": "OK|CONCERN|GAP", "note": "string" }],
  "missing_cases": [{ "case": "string", "proposal": "string" }],
  "standard_alternatives": [{ "tcode": "ME2N", "fit": "NONE|PARTIAL|FULL", "why": "string" }],
  "open_questions": ["string"] }
```
- **Failure:** non-blocking for the pipeline only if it fails twice — FSD is generated with a visible "Functional review missing" warning finding.

### 7.3 Data Analysis
- **Prompt outline:** map every selection criterion, measure and output column to catalog tables/fields · prefer header/item/history tables over views unless asked · give join keys and cardinality · give formulas for derived fields · **only use tool results**.
- **Tools:** `search_catalog(query) → {table, description}[]`, `get_table(name) → fields[]`
- **Input:** `{ spec: RequirementSpec, functional: FunctionalResult, target_release }`
- **Output:**
```json
{ "tables": [{ "name": "EKBE", "role": "PO history (GR/IR)", "access": "FAE|JOIN|SINGLE" }],
  "joins": [{ "left": "EKPO", "right": "EKKO", "on": [["EBELN","EBELN"]], "type": "INNER|LEFT" }],
  "selection_map": [{ "criterion": "Company Code", "ref": { "table": "EKKO", "field": "BUKRS" } }],
  "output_map": [{ "column": "MAT_VALUE", "source": "derived", "formula": "Σ EKBE-DMBTR signed by SHKZG", "refs": [{"table":"EKBE","field":"DMBTR"}] }],
  "catalog_misses": [{ "name": "string", "reason": "string" }] }
```
- **Failure:** platform re-checks every `ref` against the catalog; any miss not declared in `catalog_misses` → run FAILED (hallucination). Declared misses → BLOCKER finding on the FSD → FC must resolve (answer or Admin adds to catalog).

### 7.4 Tech Architect
- **Prompt outline:** ABAP architect for S/4 on-prem · pick object list and program skeleton from the `PROG_ALV` pattern · performance strategy (joins vs FAE, guards, sorted tables) · auth checks per data scope · naming per settings.
- **Input:** `{ fsd: FsdDocument (approved), data: DataAnalysisResult, settings: {prefix, target_release, package} }`
- **Output:**
```json
{ "objects": [{ "type": "PROG", "name": "ZMM_LANDED_COST", "title": "Landed Cost Report" }],
  "skeleton": { "events": ["INITIALIZATION","START-OF-SELECTION"], "units": [{ "name": "get_data", "kind": "FORM|METHOD", "fr_ids": ["FR-01","FR-02"] }] },
  "alv": { "api": "CL_SALV_TABLE", "hotspots": ["EBELN","MATNR"], "subtotals": ["BUKRS","WERKS"] },
  "performance": ["string"],
  "auth_checks": [{ "object": "M_BEST_WRK", "fields": {"WERKS":"<row>","ACTVT":"03"} }],
  "risks": ["string"] }
```
- **Failure:** objects/names checked against naming rules and catalog (classes, auth objects); violations → repair retry → FAILED.

### 7.5 FSD Generator
- **Prompt outline:** write in the template sections only · tables for §4/§5/§7 come from the Data Analysis output verbatim · every rule becomes an FR-nn · every unresolved item goes to Open Questions, never guessed · tag assumptions.
- **Input:** `{ spec, functional, data, template: FsdTemplate, previous_version?: FsdDocument, reviewer_comments?: string[] }`
- **Output (`FsdDocument`):**
```json
{ "template_version": "1.0",
  "sections": {
    "purpose": "markdown", "scope": { "in": ["..."], "out": ["..."] },
    "users": { "users": "...", "frequency": "...", "volume": "..." },
    "selection": [{ "block": "B1", "block_title": "Purchasing Data", "name": "S_BUKRS", "label": "Company Code",
                    "ref": {"table":"EKKO","field":"BUKRS"}, "kind": "SELECT_OPTION|PARAMETER|RADIO|CHECKBOX",
                    "mandatory": true, "default": null, "no_intervals": false, "group": null }],
    "data_sources": [{ "table": "EKKO", "usage": "...", "join": "..." }],
    "rules": [{ "id": "FR-01", "text": "..." }],
    "output": [{ "column": "BUKRS", "heading": "Company Code", "source": "EKKO-BUKRS", "ref_field": null, "aggregation": "SUBTOTAL|TOTAL|NONE" }],
    "interactive": "markdown", "messages": [{ "situation": "...", "behaviour": "..." }],
    "authorizations": [{ "object": "...", "check": "..." }],
    "performance": "markdown", "technical_notes": "markdown",
    "assumptions": [{ "id": "A-1", "text": "..." }],
    "open_questions": [{ "id": "Q-1", "text": "...", "why": "..." }],
    "tests": [{ "id": "T-1", "scenario": "...", "expected": "..." }] } }
```
- **Failure:** schema → repair → FAILED. Post-check: selection/output refs re-validated; FR IDs unique and sequential; on regeneration, human-edited sections are kept unless the FC asks to regenerate them.

### 7.6 Dev Agent
- **Prompt outline:** write ABAP for the target release · follow `dev.guidelines` (naming from §1.4, labels in `INITIALIZATION`, guarded FAE, select full keys for FAE, no `SELECT *`, no SELECT in loops, division guards, `CL_SALV_TABLE`, exception handling) · put `" FR-nn` comment above the code implementing each rule · use only catalog objects · on retry, fix only the listed findings and change nothing else.
- **Input:** `{ fsd: FsdDocument, tech: TechDesign, catalog_subset: {tables, fields, objects}, guidelines: string, findings?: Finding[], previous_source?: string }`
- **Output:**
```json
{ "objects": [{ "type": "PROG", "name": "ZMM_LANDED_COST",
                "source": "REPORT zmm_landed_cost. ...",
                "meta": { "title": "Landed Cost Report", "subc": "1", "fixpt": true,
                          "selection_texts": [{ "key": "S_BUKRS", "text": "Company Code", "ddic": false }],
                          "text_symbols": [] } }],
  "trace": [{ "fr_id": "FR-04", "unit": "get_data", "anchor": "FR-04" }],
  "notes": ["string"] }
```
Serializer then writes `.abapgit.xml`, `src/package.devc.xml`, `src/<name>.prog.abap`, `src/<name>.prog.xml`.
- **Failure:** schema → repair → FAILED. Output that does not parse in abaplint at all → counts as a fix-loop iteration with the parser error as a finding.

### 7.7 Validation (deterministic first)
| Check | Engine | Severity on failure |
|---|---|---|
| ABAP syntax for target release | abaplint `parser_error`, `check_syntax` | BLOCKER |
| Unknown table/field/class/tcode/auth object/param ID | catalog checker (AST) | BLOCKER |
| abapGit structure: required files, XML well-formed, TPOOL lengths, file names match object names | structure checker | BLOCKER |
| Naming rules (prefix, `gt_/lv_…`, max lengths) | abaplint naming rules + settings | WARNING |
| Every selection field has a label (`COMMENT … FOR FIELD` or selection text) | custom rule (`fdabad0` lesson) | ERROR |
| FAE without empty-driver guard; SELECT in LOOP; `SELECT *` | abaplint + custom | ERROR |
| FR coverage: every FR-nn has a `" FR-nn` anchor and the LLM judges the code under it implements the rule | LLM `validation.traceability` | ERROR if uncovered |
| Selection screen matches FSD §4 (names, kinds, mandatory, defaults) | custom comparison (FSD JSON vs AST) | ERROR |
| Output columns match FSD §7 | custom comparison | ERROR |

- **LLM part input:** `{ fsd.rules, source_with_anchors }` → **output:** `{ coverage: [{ fr_id, status: "COVERED|PARTIAL|MISSING", evidence_lines: [int], note }] }`
- **Failure:** deterministic checks cannot "fail" except by crashing (→ run FAILED, retry). LLM failure → coverage marked UNKNOWN as an ERROR finding (blocks auto-approval, can be waived by TC).

### 7.8 Code Review
- **Prompt outline:** senior ABAP reviewer · checklist: security (auth checks for data shown, `CALL TRANSACTION … WITH AUTHORITY-CHECK`, dynamic SQL/`WHERE` injection), performance, robustness (overflow, division, empty tables), S/4 compatibility (MATNR length, KONV→PRCD_ELEMENTS, obsolete statements), maintainability (FORM vs methods, literals vs text elements), correctness vs FSD · report only concrete issues with line numbers · no style nitpicks below WARNING.
- **Input:** `{ files: {path, content}[], fsd_rules, tech_design, prior_findings: Finding[] }`
- **Output:** `{ findings: Finding[], summary: string }` — every finding must have `file` + `line` inside the file, else dropped.
- **Failure:** schema → repair → FAILED (TC can retry or continue without review; continuing is audited).

---

## 8. Risks and gaps

### 8.1 Risk register

| # | Risk | Impact | Mitigation in MVP |
|---|---|---|---|
| R-1 | **Generated ABAP does not activate** in SAP (semantic errors abaplint misses: wrong type in `FOR ALL ENTRIES`, SALV method signature, release-specific syntax) | High — the core promise | abaplint with correct `syntax.version`; catalog checker; golden test; **manual ZIP import into a sandbox** as the only true proof (Q1). Label it clearly in the demo. |
| R-2 | **Hallucinated tables/fields** | High | Catalog-only grounding in prompts, tool-based lookup, hard post-check in Data Analysis and Validation (BLOCKER) |
| R-3 | **Catalog itself is wrong or thin** (hand-curated without SAP) | High | Prefer an export from a real system (DD02L/DD03L/DD04T); otherwise curate the ~25 MM tables needed and have an SAP consultant review them; record `release_min/max` |
| R-4 | Functionally wrong but syntactically fine code (e.g. wrong VGABE, sign logic) | High | FR anchors + traceability check; Functional Architect missing-case prompts; golden test scenarios T-1…T-8 reviewed by a human |
| R-5 | Release mismatch (S/4 vs ECC: KONV, MATDOC, field lengths) | Medium | `target_release` setting drives abaplint version and catalog `release_min/max` |
| R-6 | LLM data leakage — requirement text and catalog go to an external API | Medium | Single configured provider, no SAP data (only metadata) in prompts, replay mode for demos, provider choice is your call (Q2) |
| R-7 | Credential security (SAP/GitHub) | Low **in MVP** (none exist) | `SecretStore` interface ready; for production: vault, per-env SAP technical users with read-only DDIC access, short-lived GitHub app tokens |
| R-8 | Audit integrity | Medium | Append-only hash-chained `audit_log`; approvals bind to content hash; any change after approval voids it |
| R-9 | Approval bypass / self-approval | Medium | SoD guard in the transition table; tests for it |
| R-10 | Fix loop oscillates or degrades code | Medium | Max 2 iterations; Dev only sees listed findings; diff between iterations shown; stop on non-decreasing finding count |
| R-11 | Non-determinism makes the demo flaky | Medium | Replay mode; temperature ≤ 0.2; golden fixtures recorded once |
| R-12 | Local data unencrypted | Low for demo | Documented; production uses encrypted volumes / KMS |
| R-13 | GUI-only defects (labels, layout, hotspots) — like the `fdabad0` bug | Medium | Encode known ones as rules (label rule); the rest need manual SAP test |

### 8.2 How problems are caught (defence in depth)

1. **Grounded generation** — catalog subset in prompt, tools for lookup.
2. **Schema validation** — every agent output parsed, one repair.
3. **Deterministic checks** — abaplint, catalog checker, abapGit structure, FSD↔code screen/output comparison.
4. **LLM traceability** — FR coverage.
5. **LLM code review** — checklist findings.
6. **Human gates** — FSD approval, code approval, waivers audited.
7. **Real SAP** — manual import and run (outside the demo).

**Calibration test:** run Validation + Code Review on the golden repo itself. Expected: 0 BLOCKER/ERROR from deterministic checks, and Code Review reports at least items 1, 2 and 3 of §1.5. If it does not find those, the review prompt is not good enough.

### 8.3 Diagram inconsistencies / unclear points

1. **Validation Agent vs Code Review Agent overlap** ("check quality, find issues" vs "check security, performance"). Proposed split: Validation = correctness vs FSD + catalog + format; Code Review = quality/security/performance.
2. **Dev Agent "generate code & tests"** but QA Engineer "execute tests" has no agent and no test-execution path to SAP. ABAP Unit for DB-reading reports needs the OSQL test double framework — not trivial.
3. **Release Manager "approve release to next stage"** — no transport (CTS) integration is drawn. The path GitHub → abapGit pull → transport request is not defined. Who creates the transport?
4. **SAP connection label is unreadable** in the diagram ("Read/Write (as … SAP RFC … SAP APIs Transport (if needed)"). Protocol (RFC, ADT REST, OData) and what is written (code? transports?) are undefined.
5. **Infrastructure lists Vercel** alongside Kubernetes. Vercel's serverless model does not fit long agent runs or SNC/VPN tunnels to SAP.
6. **"Encrypted" on DB/storage arrows** — in transit or at rest is not stated.
7. **No feedback loops drawn** — what happens when Validation fails, or an approver rejects? The diagram is linear.
8. **Data Analysis "find data sources"** requires SAP metadata → depends on the SAP connection, which the diagram shows only to "SAP Systems", not to the agent.
9. **Admin manages "models"** implies per-agent model routing, not described elsewhere.
10. **GitHub webhooks** need a public endpoint; their purpose (PR merged → ?) is not stated.
11. **Functional Consultant vs Functional Approver** — no separation-of-duties rule stated.
12. **No business requester role** — the FC creates the requirement; the actual business owner never signs off.

---

## 9. Build plan

Estimates: one full-stack developer with AI-assisted coding, in person-days (pd). **[A-7]**

| # | Milestone (demoable) | Contents | Effort | Acceptance test |
|---|---|---|---|---|
| **M0** | Skeleton | Next.js app, SQLite + migrations, seeded users per role, login, RBAC guard, layout, audit log (hash chain), requirement list | 3 pd | Log in as each role; FC creates REQ-0001; Auditor sees the audit entry and the chain verifies; Approver cannot create requirements. |
| **M1** | LLM layer + interview | `LlmClient`, one real adapter, ReplayAdapter (record/replay), Interviewer agent, streamed chat, spec panel filling live, coverage meter, agent run monitor | 4 pd | Golden requirement text + scripted answers → `RequirementSpec` contains GR/IR basis, 3 condition-type buckets, BUKRS mandatory, subtotals, 2 drill-downs. Same run in replay mode with network off gives an identical spec. |
| **M2** | Catalog + FSD | Catalog import (JSON/CSV) and admin view; ~25 MM tables incl. the golden 6; FA + Data Analysis + FSD Generator; FSD viewer/editor per section; versions + diff; Markdown export | 5 pd | Golden spec → FSD with all 16 sections; data sources = {EKKO, EKPO, T001, LFA1, EKBE, EKBZ}; ≥ 12 of 14 FRs semantically present (human check against companion FSD); injecting a fake field `EKBE-ZZFOO` into Data Analysis output produces a BLOCKER. |
| **M3** | FSD workflow | State machine, submit/approve/reject with comments, SoD guard, notifications, dashboard by status | 2.5 pd | FC submits → Approver approves; FC cannot approve own FSD; editing an approved FSD voids approval (audit shows it); rejected FSD returns to draft with comment. |
| **M4** | Code generation + export | Tech Architect + Dev Agent, abapGit serializer, artifact sets, Monaco code view, local folder + ZIP | 4 pd | Approved golden FSD → folder with exactly `.abapgit.xml`, `src/package.devc.xml`, `src/zmm_landed_cost.prog.abap`, `src/zmm_landed_cost.prog.xml`; XML is byte-format compatible with the golden files (same envelope, TPOOL length rule); ZIP opens. |
| **M5** | Validation + review + code gate | abaplint integration, catalog checker, structure checker, FSD↔code comparisons, traceability, Code Review, fix loop (≤ 2), waivers, code approval, export lock | 5 pd | (a) Golden **reference repo** through Validation: 0 BLOCKER/ERROR. (b) Code Review on reference repo flags §1.5 items 1–3. (c) A seeded broken version (unknown field + FAE without guard + missing label) yields those 3 findings and the fix loop clears them. (d) TC approves; export hash = approved hash. |
| **M6** | Golden test + demo polish | Golden scorer (below), demo script, reset/seed command, README | 3 pd | `golden` run end-to-end in replay mode passes all MUST checks and ≥ 80% of SHOULD checks; full demo in < 15 min. |
| | **Total** | | **≈ 26.5 pd (~5–6 weeks for one dev; ~3 weeks for two)** | |

Optional M7 (if you have a sandbox): import the generated ZIP via abapGit offline, activate, run T-1…T-8. 1–2 pd.

### 9.1 Golden test case

**Input requirement text (what the FC types):**
> "Purchasing needs a report that shows the landed cost of each purchase order item: the material value plus delivery costs like freight, customs and insurance, also per unit and as a percentage of the material value. We want to see it either based on goods receipts or on invoices. Subtotals by company code and plant, and we want to jump to the PO and the material from the list."

**Scripted interview answers (stored with the fixture):** scheduling agreements yes; exclude deleted items; company code mandatory; filters plant/PO/vendor/material/doc date; freight = FRA1/FRB1/FRC1, customs = ZOA1/ZOB1/ZOC1, insurance configurable, rest = "Other"; option to include items without GR/IR; company-code currency; users can save layouts; program name `ZMM_LANDED_COST`.

**Scoring (functional equivalence, not text diff):**

| MUST (all required) | SHOULD (≥ 80%) |
|---|---|
| abaplint 0 errors | Select-options for plant, PO, vendor, material, doc date |
| 0 unknown tables/fields vs catalog | `P_OPEN`-style include-open checkbox |
| abapGit file set and names = golden | Condition-type defaults as golden |
| Reads EKBE and EKBZ with VGABE switched by GR/IR choice | Subtotals BUKRS + WERKS, grand total |
| Signs amounts by SHKZG | Hotspots EBELN → ME23N, MATNR → MM03 |
| BUKRS mandatory; GR/IR radio group; 3 condition-type select-options | Layout save enabled |
| Output has material value, 4 buckets, total DC, landed, per unit, DC % | Currency/quantity reference columns |
| Divisions guarded; FAE guarded by non-empty driver | List header depends on basis |
| FSD has ≥ 12/14 FRs and the 6 data sources | No-data message |
| | Labels set in code (works without text pool) |
| | `CL_SALV_TABLE` used |

---

## 10. Assumptions register

| ID | Assumption |
|---|---|
| A-1 | Target is S/4HANA on-premise, ABAP 7.50+ (from README wording and syntax used) |
| A-2 | Unplanned delivery costs are not in EKBZ |
| A-3 | Excluding `VGABE = '3'` in the reference is unintended or undecided, not a requirement |
| A-4/A-5 | Users, frequency, volume in the FSD are inferred |
| A-6 | SuperNova is a separate project folder; this repo is the golden fixture |
| A-7 | One developer, TypeScript-capable, AI-assisted; estimates exclude your review time |
| A-8 | No SAP system is reachable from the demo machine |
| A-9 | You have (or will get) an API key for one LLM provider; sending requirement text and DDIC metadata to it is acceptable |
| A-10 | Demo audience is internal/stakeholders, not a production pilot; English only |
| A-11 | In the demo one Technical Consultant may both waive findings and approve code |

---

## 11. Questions before building

1. **SAP access and release.** Do you have any SAP system (sandbox, trial ABAP platform, S/4 dev client) where we can (a) export the DDIC catalog for MM tables and (b) import the generated ZIP to prove activation? Which release exactly (S/4HANA 20xx on-prem, ECC, BTP ABAP Cloud)? This sets abaplint's syntax level, the catalog, and what the demo can honestly claim.
2. **LLM provider and data policy.** Which single provider and model for the demo (Claude, Azure OpenAI, OpenAI, Gemini), do you have the key, and may requirement text + DDIC metadata leave your network? Is a replay mode (recorded runs, works offline) acceptable for the live demo?
3. **Tech stack.** Is a single TypeScript app (Next.js + SQLite, `npm run dev`) acceptable, or does your team need a Python backend? Who maintains this after the demo?
4. **Coding standard for generated ABAP.** Should the Dev Agent copy the reference style (FORM routines, hard-coded English labels) so the golden test matches closely, or follow modern guidelines (local classes, text elements, `AUTHORITY-CHECK` on purchasing data)? Do you have house naming/coding rules?
5. **Demo scope confirmation.** Confirm: (a) ALV reports in MM only, (b) two approval gates (FSD + code) instead of one, (c) output = local folder + abapGit offline ZIP, with or without a local `git commit` (never pushed), (d) roles FC / Approver / TC / Admin / Auditor only.
