# SuperNova — proof of concept

Turns a plain-English business requirement into an **approved FSD** and then into **SAP ABAP code in abapGit format**, on your local machine.

```
Type (Report, Workflow, Background job, or Report + Workflow) → Chat (one prompt, then 3 to 5 AI questions, one at a time)
→ FS (generated, editable, versioned, DOCX and PDF) → Approve FS → TS (written from the approved FS, own versions and approval)
→ Code (Report only: Dev agent → rule checks → up to 3 repair passes) → Download (local folder + local git commit + abapGit ZIP)
```

**Solution types (WRICEF):** the first screen asks what kind of solution this is. Report (R) and Workflow (W) are supported; a background job is a Report that runs as a job; "Report and workflow" creates two linked requirements. Interface, Conversion, Enhancement, Form and custom/mixed show a "not supported yet" message and create nothing. Each type has its own interview, FS and TS prompts (`prompts/interviewer*.md`, `fsd*.md`, `ts-*.md`). The type can be changed later; the change must be confirmed, and existing documents are superseded, never deleted.

**Workflow:** SuperNova writes the FS and TS only. It does not create workflow objects in SAP. The FS "Process flow" table is drawn as a flowchart in the DOCX and PDF (`lib/flow-diagram.ts`); the deliverables screen lists the process flow, approval and agent matrices, trigger/event design, exception design and implementation plan.

**FSD document format:** DOCX and PDF follow the company FSD. `templates/fsd-template.docx` supplies the styles, numbering, header logos and footer table, and `templates/fsd-config.json` holds the consultant and sign-off names. The client company name and logo are asked for each requirement (and can be changed in its Client card); the SuperNova logo is fixed.

**FSD versions:** the first FSD is v1.0. *Modify FSD* takes a plain-English change, shows which sections it would touch, and writes a new version only after you confirm it. Only those sections can change: the app merges them itself, so every other section stays byte-identical. Minor changes count up (1.1, 1.2), major ones start a new number (2.0). Existing versions are never overwritten; each one can be viewed, compared and downloaded as DOCX or PDF, and any of them can be the base of a new version. A new version goes back to draft and needs approval again.

> **The generated ABAP has not been activated or run in a real SAP system.** It is checked by rules and abaplint only. To try it in SAP: abapGit → *New Offline* → *Import ZIP*, then activate in a sandbox.

## Run

```bash
npm install
cp .env.example .env        # then put your key in LLM_API_KEY
npm run dev                 # http://localhost:3000
npm run selftest            # deterministic checks against the golden repo, no LLM needed
```

Requires Node 22.5+ (uses the built-in `node:sqlite`). Tested on Node 24.

## Switching LLM provider

Only three variables in `.env` (git-ignored) change. The app speaks the OpenAI-compatible chat completions format; there is no vendor SDK.

| Provider | `LLM_BASE_URL` | `LLM_MODEL` |
|---|---|---|
| OpenAI (default) | `https://api.openai.com/v1` | `gpt-4.1` |
| Azure OpenAI (v1 API) | `https://<resource>.openai.azure.com/openai/v1` | deployment name |
| Azure OpenAI (classic) | `https://<resource>.openai.azure.com/openai/deployments/<deployment>?api-version=2024-10-21` | deployment name |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| Ollama | `http://localhost:11434/v1` (`LLM_API_KEY=ollama`) | e.g. `qwen2.5-coder:14b` |

The key is read on the server only. It is never logged, stored or sent to the browser; error messages are redacted.

Temperature is 0.1. JSON output is requested with `response_format: json_object`, validated against a JSON schema, and retried up to 2 times with the parse error in the prompt. If a model rejects `temperature` or `response_format`, the call is retried without it.

## Record / replay

`LLM_MODE` in `.env`:

- `record` (default): call the API and save every response to `data/llm-cache/<sha256>.json`.
- `replay`: never call the API; answer only from the cache. Works without internet. Needs the **exact same inputs** as the recorded run (same requirement text, same answers, same FSD edits).
- `auto`: cache hit → replay, otherwise call and record.

For a repeatable demo: run the golden case once in `record` mode, then switch to `replay`.

## Golden case

Use the **"Use golden example"** button, or paste:

> Report showing landed cost per purchase order item: material value plus freight, customs, insurance and other delivery costs, per unit and as a percentage, with subtotals by company code and plant.

The target is functional equivalence with the reference repo `fixtures/golden` (copy of `Haider-Ali077/ABAPGIT_ALV`, report `ZMM_LANDED_COST`), not matching text.

## What is where

| Path | What |
|---|---|
| `prompts/*.md` | Agent prompts (interviewer, fsd, dev, repair, review). Re-read on every call, so you can tune them without restarting. |
| `catalog/sap-catalog.json` | Local DDIC catalog: EKKO, EKPO, EKBE, EKBZ, T001, T001W, LFA1, MAKT, plus authorization objects and drill-down transactions. **Hand-curated, not exported from SAP. Verify it against SE11.** T001 is included because company-code currency (`T001-WAERS`) is needed. |
| `lib/llm.ts` | `callLLM({ system, messages, jsonSchema })`: the only place that talks to an LLM |
| `lib/agents.ts` | Interviewers (report, workflow), FS and TS Generators, Dev, Repair, Code Review |
| `lib/wricef.ts` | Solution types offered on the first screen, and which are supported |
| `lib/flow-diagram.ts` | Workflow flowchart drawn from the FS Process flow table |
| `lib/abapgit.ts` | Deterministic abapGit writer (`.abapgit.xml`, `package.devc.xml`, `.prog.abap`, `.prog.xml`). The LLM never writes XML. |
| `lib/checks.ts` | Rule-based checks: catalog tables/fields, abaplint syntax, `SELECT *`, missing `AUTHORITY-CHECK`, `CALL TRANSACTION` without authority check, wrong drill-down transaction |
| `lib/pipeline.ts` | The five steps, persistence and audit log |
| `lib/export.ts` | Local folder `output/repos/<program>/` + local git commit (no remote, never pushed) + ZIP in `output/zips/` |
| `data/supernova.db` | SQLite: requirements, chat, FSD versions, approvals, code versions, exports, audit log |

## Known limits

- The catalog check is a statement splitter plus regexes, tuned to the report pattern the Dev agent is told to write. abaplint covers syntax, but standard SAP objects (EKKO, CL_SALV_TABLE …) are "void" to abaplint, so it cannot check their fields or method signatures.
- No live SAP: activation, runtime behaviour and GUI issues (labels, hotspots) are unverified.
- No login or roles: "Functional Consultant" and "Functional Approver" are hard-coded.
- Code generation needs an approved TS for the current FS, and only covers ALV reports (CL_SALV). Code generated before the TS existed stays visible and exportable, but regenerating it needs a TS.
- Workflows: design documents only; nothing is generated or activated in SAP. The flowchart follows the FS table: with no readable table (Step, Type, Next columns, two or more steps) the diagram is left out, and a Next that points to a missing step is skipped without a message in the UI.
- An earlier answer can be revised only before the FS is written. After that, change the FS with Modify FS.
