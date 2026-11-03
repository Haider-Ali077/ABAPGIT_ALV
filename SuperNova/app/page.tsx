"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openQuestions, parseFsd } from "@/lib/fsd";
import { Coverage, FsdStep, Summary } from "./fsd-step";
import { CHOICES, otherTypeSigns, wricefCode, wricefLabel } from "@/lib/wricef";
import { docxLink, fetchJson, fmt, pdfLink, renderMarkdown, statusLabel, type State, type StepProps } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

const GOLDEN_REQUIREMENT =
  "Report showing landed cost per purchase order item: material value plus freight, customs, insurance and other delivery costs, per unit and as a percentage, with subtotals by company code and plant.";

const STEPS = ["Chat", "FS", "Approve", "TS", "Code", "Download"] as const;
const choiceIcons: Record<string, string> = { report: "▤", workflow: "↗", job: "◷", mixed: "▣" };

export default function Page() {
  const [state, setState] = useState<State | null>(null);
  const [reqId, setReqId] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState(0);
  const [versionId, setVersionId] = useState<number | null>(null);
  const [tsVersionId, setTsVersionId] = useState<number | null>(null);

  // Open the step that needs attention; the stepper can still go back to any finished step.
  useEffect(() => setView(viewOf(state?.requirement?.status)), [state?.requirement?.id, state?.requirement?.status]);
  useEffect(() => setVersionId(null), [state?.requirement?.id, state?.fsd?.id]);
  useEffect(() => setTsVersionId(null), [state?.requirement?.id, state?.ts?.id]);

  const load = useCallback(async (id: number | null) => {
    try {
      setState(await fetchJson(`/api/state${id ? `?id=${id}` : ""}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get("id")) || null;
    setReqId(id);
    load(id);
  }, [load]);

  const select = (id: number | null) => {
    setReqId(id);
    setError(null);
    window.history.replaceState(null, "", id ? `?id=${id}` : "/");
    load(id);
  };

  const run = async (action: string, label: string, payload: Record<string, unknown> = {}) => {
    setBusy(label);
    setError(null);
    try {
      const data = await fetchJson("/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id: reqId, ...payload }),
      });
      if (data.state) {
        setState(data.state);
        const newId = data.state.requirement?.id ?? null;
        if (newId !== reqId) {
          setReqId(newId);
          window.history.replaceState(null, "", newId ? `?id=${newId}` : "/");
        }
      }
      if (!data.ok) setError(data.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!state) return <div className="loading">{error ?? "Loading..."}</div>;
  const r = state.requirement;
  const step = !r ? 0 : stepOf(r.status);
  const workflow = r?.wricef === "W";
  const fsApproved = state.fsd?.status === "APPROVED";
  const tsCurrent = !!state.ts && state.ts.status === "APPROVED" && state.ts.fs_version_id === state.fsd?.id;
  const available = [
    true,
    !!r?.summary,
    !!state.fsd && r?.status !== "INTERVIEW",
    fsApproved || !!state.ts,
    workflow ? !!state.ts : state.code?.length > 0 || tsCurrent,
    workflow ? fsApproved : state.code?.length > 0,
  ];
  const props = { state, busy: !!busy, run, go: setView };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden />
          <div>
            <b>SuperNova</b>
            <small>SAP FSD to ABAP workspace</small>
          </div>
        </div>
        <span className="spacer" />
        <select className="req-select" value={reqId ?? ""} onChange={(e) => select(Number(e.target.value) || null)} disabled={!!busy} aria-label="Requirement">
          <option value="">+ New requirement</option>
          {state.requirements.map((q: any) => (
            <option key={q.id} value={q.id}>
              REQ-{q.id} · {wricefCode(q.wricef)} · {q.title.slice(0, 50)} · {q.status}
            </option>
          ))}
        </select>
        <LlmBadge llm={state.llm} />
        <span className="chip warn-chip" title="Generated ABAP is checked by rules and abaplint only. It has not been activated or run in a real SAP system."><i />SAP not activated</span>
        {r && <span className="chip type-chip">{wricefLabel(r.wricef)} ({wricefCode(r.wricef)})</span>}
        {state.fsd && <span className={`chip ${state.fsd.status.toLowerCase()}-chip`}>FS {statusLabel(state.fsd.status)} v{state.fsd.label}</span>}
        {state.ts && <span className={`chip ${state.ts.status.toLowerCase()}-chip`}>TS {statusLabel(state.ts.status)} v{state.ts.label}</span>}
      </header>

      <div className="shell">
        <aside className="rail">
          <Workflow state={state} step={step} view={view} available={available} setView={setView} />
          {state.fsd && (
            <Versions
              title="FS versions"
              versions={state.fsdVersions}
              selected={versionId ?? state.fsd.id}
              onSelect={(id) => {
                setVersionId(id);
                setView(1);
              }}
            />
          )}
          {state.ts && (
            <Versions
              title="TS versions"
              versions={state.tsVersions}
              selected={tsVersionId ?? state.ts.id}
              onSelect={(id) => {
                setTsVersionId(id);
                setView(3);
              }}
            />
          )}
        </aside>

        <main className="content">
          {(busy || error) && (
            <div className="sticky">
              {busy && <BusyBar label={busy} />}
              {error && <ErrorBox message={error} onClose={() => setError(null)} />}
            </div>
          )}

          {/* Hidden, not unmounted: switching steps must not throw away a half-typed answer or FSD edit. */}
          <div hidden={view !== 0}><ChatStep {...props} /></div>
          {r && <div hidden={view !== 1}><FsdStep {...props} versionId={versionId} setVersionId={setVersionId} /></div>}
          {available[2] && <div hidden={view !== 2}><ApproveStep {...props} /></div>}
          {available[3] && <div hidden={view !== 3}><FsdStep {...props} kind="TS" versionId={tsVersionId} setVersionId={setTsVersionId} /></div>}
          {available[4] && <div hidden={view !== 4}>{workflow ? <DesignStep {...props} /> : <CodeStep {...props} />}</div>}
          {available[5] && <div hidden={view !== 5}><DownloadStep {...props} /></div>}
        </main>

        {r && (
          <aside className="rail">
            <ClassificationCard state={state} busy={!!busy} run={run} />
            <ClientCard state={state} busy={!!busy} run={run} />
            <Readiness state={state} />
            <div className="card side">
              <h4>SAP status</h4>
              <p className="muted">Generated code stays in this workspace. It is not activated in SAP until you import it.</p>
            </div>
            <AuditLog audit={state.audit} />
          </aside>
        )}
      </div>
    </div>
  );
}

function stepOf(status: string) {
  return { INTERVIEW: 0, SUMMARY_READY: 1, FSD_DRAFT: 2, FSD_APPROVED: 3, TS_DRAFT: 3, TS_APPROVED: 4, CODE_READY: 5, EXPORTED: 6 }[status] ?? 0;
}

/** The step to open for a status. Each stays on its own step until the user moves on: a draft FSD is read, an approved one downloaded, fresh code checked. */
function viewOf(status?: string) {
  return { INTERVIEW: 0, SUMMARY_READY: 1, FSD_DRAFT: 1, FSD_APPROVED: 2, TS_DRAFT: 3, TS_APPROVED: 4, CODE_READY: 4, EXPORTED: 5 }[status ?? ""] ?? 0;
}

// ---------------------------------------------------------------------- Rails
function Workflow({ state, step, view, available, setView }: { state: State; step: number; view: number; available: boolean[]; setView: (i: number) => void }) {
  const r = state.requirement;
  const fsd = state.fsd;
  const final = state.code?.[state.code.length - 1];
  const ts = state.ts;
  const workflow = r?.wricef === "W";
  const tsNote = !ts ? (fsd?.status === "APPROVED" ? "Ready to write" : "After FS approval") : ts.status === "APPROVED" ? `v${ts.label} approved` : ts.status === "SUPERSEDED" ? "Out of date" : `v${ts.label}, waiting for approval`;
  const notes = [
    !r ? "Choose the type first" : r.status === "INTERVIEW" ? `${r.questions_asked} ${r.questions_asked === 1 ? "question" : "questions"} so far` : "Requirement captured",
    fsd ? `v${fsd.label}, ${parseFsd(fsd.markdown).sections.length} sections` : "Not generated yet",
    !fsd ? "After the FS" : fsd.status === "APPROVED" ? `v${fsd.label} approved` : "Waiting for approval",
    tsNote,
    workflow
      ? ts?.status === "APPROVED" ? "Technical design ready" : "After TS approval"
      : final ? `v${final.version}, ${final.checks.errors} ${final.checks.errors === 1 ? "error" : "errors"}` : ts?.status === "APPROVED" ? "Ready to generate" : "Locked until TS approved",
    workflow ? (fsd?.status === "APPROVED" ? "FS and TS documents" : "After FS approval") : !final ? "Locked until code is ready" : final.checks.errors ? "Fix errors first" : "Ready to export",
  ];
  const label = (s: string) => (workflow && s === "Code" ? "Deliverables" : s);
  return (
    <nav className="card side" aria-label="Workflow">
      <h4>Workflow</h4>
      <ol className="workflow">
        {STEPS.map((s, i) => (
          <li key={s} className={i < step ? "done" : i === step ? "current" : ""}>
            <button className={i === view ? "viewing" : ""} onClick={() => setView(i)} disabled={!available[i]} aria-current={i === view ? "step" : undefined}>
              <span className="mark">
                {i < step ? "✓" : !available[i] ? (
                  <span className="lock" aria-hidden="true">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="3.5" y="7" width="9" height="7" rx="1.5" />
                      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
                    </svg>
                  </span>
                ) : i + 1}
              </span>
              <span className="label"><b>{label(s)}</b><small>{notes[i]}</small></span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Versions({ title, versions, selected, onSelect }: { title: string; versions: any[]; selected: number; onSelect: (id: number) => void }) {
  return (
    <div className="card side">
      <h4>{title}</h4>
      <div className="version-list">
        {versions.map((v, i) => (
          <button key={v.id} className={v.id === selected ? "selected" : ""} onClick={() => onSelect(v.id)}>
            <span><b>v{v.label}</b><small>{v.change_summary}</small></span>
            {i === 0 && <em>Current</em>}
          </button>
        ))}
      </div>
    </div>
  );
}

function Readiness({ state }: { state: State }) {
  const fsd = state.fsd;
  const final = state.code?.[state.code.length - 1];
  const resolved = new Set(state.annotations?.filter((a: any) => a.kind === "RESOLVED").map((a: any) => a.section));
  const sections = fsd ? parseFsd(fsd.markdown).sections : [];
  const open = fsd ? openQuestions(fsd.markdown).filter((q) => !resolved.has(q)).length : 0;
  const workflow = state.requirement?.wricef === "W";
  const core = workflow
    ? ["processflow", "triggerandstartconditions", "approvalmatrix", "agentdetermination", "exceptionhandling"]
    : ["selectionscreen", "datasources", "businessrules", "outputcolumns"];
  const complete = core.every((k) => sections.some((s) => s.key === k));
  const items: [string, string, boolean][] = [
    [complete ? `All ${sections.length} sections present` : "Sections", !fsd ? "Pending" : complete ? "Done" : "Missing", complete],
    ["Open questions", !fsd ? "Pending" : open ? `${open} open` : "None", !!fsd && open === 0],
    workflow
      ? ["Technical spec", state.ts?.status === "APPROVED" ? "Approved" : state.ts ? "Draft" : "Not written", state.ts?.status === "APPROVED"]
      : ["abaplint", final ? `${final.checks.errors} errors` : "Not run", !!final && final.checks.errors === 0],
    ["Approval", fsd?.status === "APPROVED" ? "Approved" : "Pending", fsd?.status === "APPROVED"],
  ];
  const done = items.filter((i) => i[2]).length;
  return (
    <div className="card side">
      <div className="row tight between">
        <h4>Readiness</h4>
        <b>{done} of {items.length}</b>
      </div>
      <div className="progress" role="progressbar" aria-valuenow={done} aria-valuemax={items.length}><span style={{ width: `${(done / items.length) * 100}%` }} /></div>
      <ul className="readiness">
        {items.map(([label, value, ok]) => (
          <li key={label}>
            <span>{label}</span>
            <span className={`pill ${ok ? "good" : /Pending|Not run/.test(value) ? "" : "draft"}`}>{value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --------------------------------------------------------------------- Client
type ClientDraft = { name: string; logo?: string; logoType?: string; preview?: string; fileName?: string; error?: string };

const clientPayload = (c: ClientDraft) => ({ name: c.name.trim(), logo: c.logo, logoType: c.logoType });
const logoUrl = (c: { id: number; updatedAt: string }) => `/api/client-logo?id=${c.id}&v=${encodeURIComponent(c.updatedAt)}`;

/** Company name with suggestions from earlier requirements, and its logo. A saved company brings its saved logo. */
function ClientFields({ clients, value, onChange, project, onProjectChange }: {
  clients: any[];
  value: ClientDraft;
  onChange: (c: ClientDraft) => void;
  project?: string;
  onProjectChange?: (project: string) => void;
}) {
  const saved = clients.find((c) => c.name.toLowerCase() === value.name.trim().toLowerCase());
  const pick = (file?: File) => {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) return onChange({ ...value, logo: undefined, preview: undefined, error: "The logo must be a PNG or JPG image." });
    if (file.size > 1_000_000) return onChange({ ...value, logo: undefined, preview: undefined, error: "The logo must be smaller than 1 MB." });
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      onChange({ ...value, logo: url.slice(url.indexOf(",") + 1), logoType: file.type, preview: url, fileName: file.name, error: undefined });
    };
    reader.readAsDataURL(file);
  };
  const shown = value.preview ?? (saved?.hasLogo ? logoUrl(saved) : undefined);
  return (
    <div className={`client-fields ${onProjectChange ? "with-project" : ""}`}>
      <div>
        <label className="field-label" htmlFor="client-name">Client company name</label>
        <input id="client-name" type="text" list="client-names" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="The company this FSD is for" autoComplete="off" />
        <datalist id="client-names">{clients.map((c) => <option key={c.id} value={c.name} />)}</datalist>
      </div>
      {onProjectChange && (
        <div>
          <label className="field-label" htmlFor="project">Project <span className="muted small">(optional)</span></label>
          <input id="project" type="text" value={project ?? ""} onChange={(e) => onProjectChange(e.target.value)} placeholder="For example: S/4HANA rollout phase 2" />
        </div>
      )}
      <div className="logo-field">
        <span className="field-label">Client logo</span>
        <div className="logo-picker">
          <div className="logo-preview">{shown ? <img src={shown} alt="Client logo" /> : <span className="muted small">No logo</span>}</div>
          <div>
            <label className="button secondary small-btn file-button">
              {shown ? "Change logo" : "Upload logo"}
              <input type="file" accept="image/png,image/jpeg" onChange={(e) => pick(e.target.files?.[0])} />
            </label>
            <p className="muted small">
              {value.error ? <span className="warn">{value.error}</span> : value.fileName ?? (saved?.hasLogo ? "Saved logo for this company" : "PNG or JPG, under 1 MB. Shown next to the SuperNova logo on the FSD.")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClassificationCard({ state, busy, run }: Pick<StepProps, "state" | "busy" | "run">) {
  const r = state.requirement;
  const other = r.wricef === "W" ? "R" : "W";
  const change = () => {
    const from = wricefLabel(r.wricef);
    const to = wricefLabel(other);
    if (!confirm(`Change this requirement from ${from} to ${to}?\n\nThe interview restarts with ${to.toLowerCase()} questions. FS and TS versions written for a ${from.toLowerCase()} stay in the history but are no longer current. Approval records are kept.`)) return;
    run("changeWricef", `Re-checking the requirement as a ${to.toLowerCase()}`, { wricef: other, confirmed: true });
  };
  return (
    <div className="card side">
      <div className="row tight between">
        <h4>Classification</h4>
        <button className="secondary small-btn" onClick={change} disabled={busy}>Change type</button>
      </div>
      <p className="classification"><b>{wricefLabel(r.wricef)}</b> <span className="pill accent">{wricefCode(r.wricef)}</span></p>
      {r.wricef === "R" && <p className="muted small">{r.execution_mode === "BACKGROUND" ? "Runs as a background job" : "Run online"}{r.summary?.report_type ? ` · ${r.summary.report_type}` : ""}</p>}
      {r.wricef === "W" && r.summary?.technology && <p className="muted small">{r.summary.technology}</p>}
      {r.project && <p className="muted small">Project: {r.project}</p>}
      {r.linked && <p className="small">Linked {wricefLabel(r.linked.wricef).toLowerCase()} part: <a href={`?id=${r.linked.id}`}>REQ-{r.linked.id}</a></p>}
    </div>
  );
}

function ClientCard({ state, busy, run }: Pick<StepProps, "state" | "busy" | "run">) {
  const client = state.requirement.client;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ClientDraft>({ name: "" });
  const open = () => {
    setDraft({ name: client?.name ?? "" });
    setEditing(true);
  };
  return (
    <div className={`card side ${client ? "" : "attention"}`}>
      <div className="row tight between">
        <h4>Client</h4>
        {!editing && <button className="secondary small-btn" onClick={open} disabled={busy}>{client ? "Change" : "Add client"}</button>}
      </div>
      {editing ? (
        <>
          <ClientFields clients={state.clients} value={draft} onChange={setDraft} />
          <div className="row">
            <button
              onClick={async () => {
                await run("setClient", "Saving the client", { client: clientPayload(draft) });
                setEditing(false);
              }}
              disabled={busy || draft.name.trim().length < 2 || !!draft.error}
            >
              Save
            </button>
            <button className="secondary" onClick={() => setEditing(false)}>Cancel</button>
          </div>
          <p className="muted small">Applies to every FSD download for this requirement.</p>
        </>
      ) : client ? (
        <div className="client-current">
          {client.hasLogo && <img src={logoUrl(client)} alt="" />}
          <b>{client.name}</b>
          {!client.hasLogo && <p className="muted small">No logo yet. Only the SuperNova logo is shown on the FSD.</p>}
        </div>
      ) : (
        <p className="warn small">Not set. FSD downloads have no company name or client logo until you add one.</p>
      )}
    </div>
  );
}

function LlmBadge({ llm }: { llm: any }) {
  return (
    <div className="badge" title="LLM settings from .env (the API key is never sent to the browser)">
      <b>{llm.mode}</b> · {llm.model}
      {!llm.keySet && llm.mode !== "replay" && <span className="warn"> · LLM_API_KEY not set</span>}
    </div>
  );
}

function BusyBar({ label }: { label: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="busy" role="status">
      <i className="spinner" /> {label}
      <span className="spacer" />
      <span className="mono small">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
    </div>
  );
}

function friendlyError(message: string) {
  if (/credit_balance_exhausted|insufficient_quota|no credits/i.test(message)) {
    return { title: "The LLM account is out of credits", hint: "Add credits with your provider, then try again. Nothing was lost." };
  }
  if (/HTTP 401|invalid_api_key|incorrect api key/i.test(message)) {
    return { title: "The LLM rejected the API key", hint: "Check LLM_API_KEY in .env and restart the app." };
  }
  if (/HTTP 429/.test(message)) return { title: "The LLM is rate limiting requests", hint: "Wait a minute, then try again." };
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    return { title: "The LLM could not be reached", hint: "Check your connection and LLM_BASE_URL in .env." };
  }
  return null;
}

function ErrorBox({ message, onClose }: { message: string; onClose: () => void }) {
  const known = friendlyError(message);
  return (
    <div className="error" role="alert">
      <button className="close" onClick={onClose} aria-label="Dismiss">×</button>
      {known ? (
        <>
          <b>{known.title}</b> <span>{known.hint}</span>
          <details>
            <summary>Technical details</summary>
            <pre>{message}</pre>
          </details>
        </>
      ) : message}
    </div>
  );
}

// ------------------------------------------------------------------- 1. Chat
function ChatStep({ state, busy, run }: StepProps) {
  const r = state.requirement;
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState("");
  const [client, setClient] = useState<ClientDraft>({ name: "" });
  const [choice, setChoice] = useState("");
  const [project, setProject] = useState("");
  const [revising, setRevising] = useState(false);
  const [revision, setRevision] = useState("");

  if (!r) {
    const chosen = CHOICES.find((c) => c.id === choice);
    const signs = chosen?.supported ? otherTypeSigns(text) : [];
    const ready = !!chosen?.supported && client.name.trim().length >= 2 && !client.error && text.trim().length >= 15;
    const hint = !chosen ? "Choose the kind of solution first." : client.name.trim().length < 2 ? "Enter the client company name." : client.error ?? "Describe the requirement in at least one sentence.";
    return (
      <>
      <div className="card hero">
        <h1>What do you need?</h1>
        <p className="muted">First, what kind of solution is this? It decides which questions the AI asks and how the FS and TS are written.</p>
        <h4 className="choice-group-label">Available now</h4>
        <div className="choices" role="radiogroup" aria-label="Kind of solution">
          {CHOICES.filter((c) => c.supported).map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={choice === c.id} className={`choice ${choice === c.id ? "selected" : ""}`} onClick={() => setChoice(c.id)} disabled={busy}>
              <span className="choice-top">
                <span className="choice-icon" aria-hidden="true">{choiceIcons[c.id]}</span>
                {choice === c.id ? <span className="choice-check" aria-hidden="true">✓</span> : <span className="code">{c.code}</span>}
              </span>
              <span className="choice-head"><b>{c.label}</b></span>
              <small>{c.hint}</small>
            </button>
          ))}
        </div>
        <h4 className="choice-group-label">Coming soon</h4>
        <div className="coming-soon" aria-label="Coming soon">
          {CHOICES.filter((c) => !c.supported).map((c) => (
            <button key={c.id} type="button" className="choice unsupported" disabled aria-label={`${c.label}, coming soon`}>
              <span className="choice-name">{c.label}</span>
              <em>Soon</em>
            </button>
          ))}
        </div>

        {chosen && !chosen.supported && (
          <div className="notice unsupported-note" role="status">
            <div>
              <b>{chosen.label}{chosen.code !== "-" && ` (${chosen.code})`}</b>
              <p>{chosen.message}</p>
              <p className="muted small">SuperNova fully supports Report (R) and Workflow (W). {text.trim() && "Your description below is kept."}</p>
            </div>
            <button className="secondary" onClick={() => setChoice("")}>Back to classification</button>
          </div>
        )}

        {chosen?.supported && (
          <>
            {chosen.linked && <p className="notice small">Two linked requirements are created: one Report and one Workflow, sharing this description. The interview starts with the report part; open the workflow part from its Classification card.</p>}
            {chosen.execution === "BACKGROUND" && <p className="notice small">A background job is built as a Report that runs without a dialog, with variants and a job schedule.</p>}
            <ClientFields clients={state.clients} value={client} onChange={setClient} project={project} onProjectChange={setProject} />
          </>
        )}
        {(chosen?.supported || text) && (
          <>
            <label className="field-label" htmlFor="requirement-text">Requirement</label>
            <textarea id="requirement-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: a report of open vendor items by aging bucket, with subtotals by company code." disabled={!chosen?.supported} />
            {chosen?.supported && (
              <div className="requirement-examples">
                <span>Try:</span>
                <button type="button" className="example-chip" onClick={() => setText(GOLDEN_REQUIREMENT)} disabled={busy}>Landed cost by purchase order</button>
                <button type="button" className="example-chip" onClick={() => setText("Route purchase order approvals by amount, with escalation when an approver misses the deadline.")} disabled={busy}>Purchase order approval by amount</button>
              </div>
            )}
          </>
        )}
        {signs.length > 0 && (
          <p className="warn small">This description sounds like it may also be {signs.join(" or ")}. SuperNova only builds Report and Workflow. Continue only if this really is a {chosen!.label.toLowerCase()}; otherwise go back and choose the right type.</p>
        )}
        {chosen?.supported && !ready && <p className="muted small form-hint">{hint}</p>}
      </div>
      <footer className="hero-action-bar">
        <span className="selected-type">Selected: <b>{chosen?.label ?? "Choose a type"}</b></span>
        <button
          onClick={() => chosen && run("start", "Interviewer agent is reading the requirement", { text, client: clientPayload(client), choice: chosen.id, project })}
          disabled={busy || !ready}
        >
          Start chat →
        </button>
      </footer>
      </>
    );
  }

  const last = state.messages[state.messages.length - 1];
  const waitingForUser = r.status === "INTERVIEW" && last?.role === "assistant";
  const needsRetry = r.status === "INTERVIEW" && (!last || last.role === "user");
  const send = async (action: string, label: string, reply: string) => {
    await run(action, label, { text: reply });
    setAnswer("");
  };

  return (
    <div className="card">
      <h2>Requirement chat <span className="pill accent">{wricefLabel(r.wricef)} ({wricefCode(r.wricef)})</span> <span className="pill">{r.questions_asked} of up to {state.maxQuestions} questions</span></h2>
      <div className="chat">
        <div className="msg user"><b>Functional Consultant</b><p>{r.requirement_text}</p></div>
        {state.messages.map((m: any, i: number) => (
          <div key={i} className={`msg ${m.role}`}>
            <b>{m.role === "user" ? "Functional Consultant" : "Interviewer agent"}</b>
            <p>{m.content}</p>
          </div>
        ))}
      </div>
      {(r.interview?.coverage?.length > 0 || r.interview?.contradictions?.length > 0) && (
        <div className="tracking">
          {r.interview.contradictions?.length > 0 && <div className="notice"><span><b>Contradiction:</b> {r.interview.contradictions.join(" ")}</span></div>}
          <Coverage items={r.interview.coverage ?? []} />
        </div>
      )}
      {waitingForUser && (
        <>
          <textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Type your answer" />
          <div className="row">
            <button onClick={() => send("answer", "Interviewer agent is thinking", answer)} disabled={busy || !answer.trim()}>Send answer</button>
            <button className="secondary" onClick={() => send("answer", "Interviewer agent is thinking", "Skip this question. Use your recommended default and record it as an assumption.")} disabled={busy}>Skip question</button>
            <span className="spacer" />
            <button
              className="secondary"
              onClick={() => send("finishInterview", "Wrapping up the requirement", answer.trim() || "That is enough. Use your recommended defaults for anything not covered and record them as assumptions.")}
              disabled={busy}
            >
              Enough, write the FS
            </button>
          </div>
        </>
      )}
      {needsRetry && (
        <div className="row">
          <button onClick={() => run("answer", "Interviewer agent is thinking")} disabled={busy}>Retry interviewer</button>
          <span className="muted small">Your answers are saved.</span>
        </div>
      )}
      {["INTERVIEW", "SUMMARY_READY"].includes(r.status) && !state.fsd && state.messages.some((m: any) => m.role === "user") && (
        revising ? (
          <div className="revise">
            <label className="field-label" htmlFor="revise">Correct an earlier answer</label>
            <textarea id="revise" rows={2} value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="For example: approvals over 50,000 need the CFO, not the department head." />
            <div className="row">
              <button onClick={async () => { await run("reviseAnswer", "Interviewer agent is re-checking the requirement", { text: revision }); setRevision(""); setRevising(false); }} disabled={busy || !revision.trim()}>Save correction</button>
              <button className="secondary" onClick={() => setRevising(false)}>Cancel</button>
              <span className="muted small">The correction wins over the earlier answer. Nothing is deleted from the conversation.</span>
            </div>
          </div>
        ) : (
          <div className="row"><button className="secondary small-btn" onClick={() => setRevising(true)} disabled={busy}>Revise an earlier answer</button></div>
        )
      )}
      {r.summary && (
        <details open={r.status === "SUMMARY_READY"}>
          <summary>Structured requirement summary{state.revisions?.length > 0 && ` · revision ${state.revisions[0].revision}`}</summary>
          <Summary data={r.summary} />
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 3. Approve
function FsdDownloads({ fsd }: { fsd: any }) {
  return (
    <div className="row">
      <a className="button" href={docxLink(fsd.id)}>Download DOCX</a>
      <a className="button secondary" href={pdfLink(fsd.id)}>Download PDF</a>
    </div>
  );
}

function ApproveStep({ state, busy, run, go }: StepProps) {
  const fsd = state.fsd;
  const html = useMemo(() => renderMarkdown(fsd.markdown), [fsd.markdown]);
  return (
    <div className="card">
      <h2>Approval</h2>
      {fsd.status === "DRAFT" ? (
        <div className="row">
          <button onClick={() => run("approve", "Recording approval", { fsdVersionId: fsd.id })} disabled={busy}>
            Approve FSD v{fsd.label} as Functional Approver
          </button>
          <span className="muted small">Approving signs this exact text (sha256 {fsd.sha256.slice(0, 12)}…). Any later edit creates a new draft version.</span>
        </div>
      ) : (
        <div className="row">
          <span>FSD v{fsd.label} is <b>{statusLabel(fsd.status)}</b>.</span>
          <span className="spacer" />
          {fsd.status === "APPROVED" && <button onClick={() => go(3)}>Continue to ABAP code</button>}
        </div>
      )}
      <FsdDownloads fsd={fsd} />
      <details open={fsd.status === "DRAFT"}>
        <summary>Read FSD v{fsd.label}</summary>
        <article className="markdown boxed" dangerouslySetInnerHTML={{ __html: html }} />
      </details>
      {state.approvals.length > 0 && (
        <table>
          <thead>
            <tr><th>FSD version</th><th>Decision</th><th>Who</th><th>When</th><th>sha256</th></tr>
          </thead>
          <tbody>
            {state.approvals.map((a: any) => (
              <tr key={a.id}>
                <td>v{a.label}</td><td>{a.decision}</td><td>{a.approver}</td><td>{fmt(a.decided_at)}</td><td className="mono">{a.sha256.slice(0, 16)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- 4. Code
/** A workflow's deliverables are its documents. Nothing is presented as deployable. */
function DesignStep({ state, go }: StepProps) {
  const has = (doc: any, key: string) => !!doc && parseFsd(doc.markdown).sections.some((s) => s.key.startsWith(key));
  const fs = state.fsd;
  const ts = state.ts;
  const items: [string, string, boolean, number][] = [
    ["Functional specification", fs ? `v${fs.label} · ${statusLabel(fs.status)}` : "Not written", !!fs, 1],
    ["Technical specification", ts ? `v${ts.label} · ${statusLabel(ts.status)}` : "Not written", !!ts, 3],
    ["Process flow diagram", "FS, Process flow", has(fs, "processflow"), 1],
    ["Approval matrix", "FS, Approval matrix", has(fs, "approvalmatrix"), 1],
    ["Agent determination matrix", "FS and TS, Agent determination", has(fs, "agentdetermination") || has(ts, "agentdetermination"), 1],
    ["Trigger and event design", "TS, Trigger and event design", has(ts, "triggerandeventdesign"), 3],
    ["Exception-handling design", "TS, Exception handling design", has(ts, "exceptionhandlingdesign"), 3],
    ["Technical implementation plan", "TS, Technical implementation plan", has(ts, "technicalimplementationplan"), 3],
  ];
  return (
    <div className="card">
      <h2>Workflow deliverables</h2>
      <p className="notice small">{state.requirement.codeBlocker}</p>
      <ul className="deliverables">
        {items.map(([name, where, ok, view]) => (
          <li key={name}>
            <span className={`pill ${ok ? "good" : ""}`}>{ok ? "Included" : "Missing"}</span>
            <b>{name}</b>
            <span className="muted small">{where}</span>
            <span className="spacer" />
            <button className="secondary small-btn" onClick={() => go(view)}>Open</button>
          </li>
        ))}
      </ul>
      <div className="row">
        {fs && <a className="button secondary" href={docxLink(fs.id)}>FS v{fs.label} (DOCX)</a>}
        {ts && <a className="button secondary" href={docxLink(ts.id)}>TS v{ts.label} (DOCX)</a>}
      </div>
    </div>
  );
}

function CodeStep({ state, busy, run, go }: StepProps) {
  const ts = state.ts;
  const tsReady = !!ts && ts.status === "APPROVED" && ts.fs_version_id === state.fsd?.id;
  const blocker = state.requirement.codeBlocker;
  const approved = state.fsd.status === "APPROVED" && tsReady && !blocker;
  const codes = state.code as any[];
  const final = codes[codes.length - 1];
  const earlier = codes.slice(0, -1).reverse();
  return (
    <div className="card">
      <h2>ABAP code</h2>
      <div className="row">
        <button
          className={codes.length ? "secondary" : ""}
          onClick={() => run("generateCode", "Dev agent is writing ABAP, then checks and (if needed) up to 3 repair passes run. This can take 1-5 minutes")}
          disabled={busy || !approved}
        >
          {codes.length ? "Regenerate ABAP" : "Generate ABAP"}
        </button>
        {!approved && <span className="muted small">{blocker ?? (state.fsd.status !== "APPROVED" ? "Approve the latest FS first." : "Write and approve the TS for the current FS first. The code follows the approved TS.")}</span>}
        {!tsReady && !blocker && <button className="secondary" onClick={() => go(3)}>Open the TS</button>}
        {final && (
          <button className="secondary" onClick={() => run("review", "Code Review agent is reading the code")} disabled={busy}>
            {final.review ? "Re-run code review (LLM)" : "Run code review (LLM)"}
          </button>
        )}
        <span className="spacer" />
        {final?.checks.errors === 0 && <button onClick={() => go(4)}>Continue to export</button>}
      </div>
      {final && <Verdict c={final} />}
      {final && <CodeVersionView key={final.id} c={final} isFinal />}
      {earlier.length > 0 && (
        <details className="earlier">
          <summary>
            Earlier attempt: {earlier.map((c) => `v${c.version} (${c.checks.errors} errors)`).join(", ")}
            {final.checks.errors === 0 ? ", all fixed in the version above" : ""}
          </summary>
          <p className="muted">Kept for the record. These errors belong to the older code. Only the version above is exported.</p>
          {earlier.map((c) => (
            <CodeVersionView key={c.id} c={c} isFinal={false} />
          ))}
        </details>
      )}
    </div>
  );
}

/** The answer to "can I use this?", before any detail. */
function Verdict({ c }: { c: any }) {
  const { errors, warnings, issues } = c.checks;
  const rules: Record<string, number> = {};
  for (const i of issues) if (i.severity === "error") rules[i.rule] = (rules[i.rule] ?? 0) + 1;
  return (
    <div className={`verdict ${errors ? "bad" : "good"}`}>
      <div className="verdict-mark" aria-hidden>{errors ? "✖" : "✓"}</div>
      <div>
        <b>{errors ? `${errors} ${errors === 1 ? "error" : "errors"} to fix before export` : "All checks passed"}</b>
        <p>
          {errors
            ? "Regenerate ABAP to try again. Click a line number below to see the code."
            : `Ready to export${warnings ? `, with ${warnings} ${warnings === 1 ? "warning" : "warnings"}` : ""}. Activate it in an SAP sandbox before relying on it.`}
        </p>
        {errors > 0 && (
          <div className="chips">
            {Object.entries(rules).map(([rule, n]) => <span key={rule} className="pill bad">{rule} · {n}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}

function CodeVersionView({ c, isFinal }: { c: any; isFinal: boolean }) {
  const ch = c.checks;
  const [open, setOpen] = useState(isFinal);
  const [focus, setFocus] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  // Issues are sorted errors first, so walk them backwards: an error wins over a warning on the same line.
  const flagged = useMemo(() => new Map<number, string>([...ch.issues].reverse().filter((i: any) => i.line).map((i: any) => [i.line, i.severity])), [ch.issues]);

  const jump = (line: number) => {
    setOpen(true);
    setFocus(line);
    requestAnimationFrame(() => document.getElementById(`code-${c.id}-${line}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };
  const copy = async () => {
    await navigator.clipboard.writeText(c.abap_source);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`code-version ${isFinal ? "final" : ""}`}>
      <h3>
        {isFinal && <span className="pill accent">Latest</span>}
        v{c.version} · {c.kind === "REPAIRED" ? "after repair pass" : "first pass"} · {c.program_name}
        <span className={`pill ${ch.errors ? "bad" : "good"}`}>{ch.errors} errors · {ch.warnings} warnings</span>
        <span className="muted small">abaplint: {ch.abaplint}</span>
      </h3>
      <p className="muted">{c.title}</p>
      {ch.issues.length > 0 && (
        <table className="issues">
          <thead>
            <tr><th></th><th>Rule</th><th>Line</th><th>Message</th></tr>
          </thead>
          <tbody>
            {ch.issues.map((i: any, n: number) => (
              <tr key={n} className={i.severity}>
                <td>{i.severity === "error" ? "✖" : "⚠"}</td>
                <td>{i.rule}</td>
                <td>{i.line ? <button className="link" onClick={() => jump(i.line)} title="Show this line in the source">{i.line}</button> : ""}</td>
                <td>{i.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>src/{c.program_name.toLowerCase()}.prog.abap ({c.abap_source.split("\n").length} lines)</summary>
        <div className="source-wrap">
          <button className="secondary copy" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          <pre className="source">
            {c.abap_source.split("\n").map((l: string, i: number) => (
              <div key={i} id={`code-${c.id}-${i + 1}`} className={`${flagged.has(i + 1) ? `flag-${flagged.get(i + 1)}` : ""} ${focus === i + 1 ? "focus" : ""}`}>
                <span className="ln">{i + 1}</span>{l || " "}
              </div>
            ))}
          </pre>
        </div>
      </details>
      <details>
        <summary>Selection texts and abapGit XML (written by fixed code, not the LLM)</summary>
        <ul>{c.selection_texts.map((s: any) => <li key={s.key}><code>{s.key}</code> {s.text}</li>)}</ul>
        {c.files.map((f: any) => (
          <div key={f.path}>
            <b className="mono">{f.path}</b>
            <pre className="xml">{f.content}</pre>
          </div>
        ))}
      </details>
      {c.review && (
        <div className="review">
          <h4>Code review (LLM): {c.review.summary}</h4>
          {c.review.findings.length === 0 ? <p>No findings.</p> : (
            <table>
              <thead><tr><th>Severity</th><th>Line</th><th>Finding</th><th>Suggestion</th></tr></thead>
              <tbody>
                {c.review.findings.map((f: any, i: number) => (
                  <tr key={i}>
                    <td><span className={`pill ${f.severity === "high" ? "bad" : f.severity === "medium" ? "draft" : ""}`}>{f.severity}</span></td>
                    <td><button className="link" onClick={() => jump(f.line)}>{f.line}</button></td>
                    <td><b>{f.title}</b> {f.detail}</td>
                    <td>{f.suggestion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------- 5. Download
function DownloadStep({ state, busy, run }: StepProps) {
  const docs = [state.fsd, state.ts].filter(Boolean);
  const documents = (
    <div className="row">
      {docs.map((d: any) => (
        <span key={d.id} className="doc-links">
          <b>{d.doc_type === "TS" ? "TS" : "FS"} v{d.label}</b>
          <a className="button secondary small-btn" href={docxLink(d.id)}>DOCX</a>
          <a className="button secondary small-btn" href={pdfLink(d.id)}>PDF</a>
        </span>
      ))}
    </div>
  );
  if (state.requirement.wricef === "W") {
    return (
      <div className="card">
        <h2>Download</h2>
        <p className="muted">A workflow has no abapGit export: its deliverables are the FS and the TS. Download any version from the version history.</p>
        {documents}
      </div>
    );
  }
  const codes = state.code as any[];
  const final = codes[codes.length - 1];
  const [force, setForce] = useState(false);
  const errors = final.checks.errors;
  return (
    <div className="card">
      <h2>Export and download</h2>
      <p className="muted">
        Writes <code>.abapgit.xml</code>, <code>src/package.devc.xml</code>, <code>src/{final.program_name.toLowerCase()}.prog.abap</code>,{" "}
        <code>src/{final.program_name.toLowerCase()}.prog.xml</code> and <code>docs/FSD.md</code> to a local folder, commits them to a local git
        repository (never pushed) and builds a ZIP for abapGit <i>New Offline → Import ZIP</i>.
      </p>
      <div className="row">
        <button onClick={() => run("export", "Exporting", { force })} disabled={busy || (errors > 0 && !force)}>
          Export v{final.version}
        </button>

        {errors > 0 && (
          <label className="warn">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> export anyway ({errors} check errors remain)
          </label>
        )}
      </div>
      {documents}
      {state.exports.length > 0 && (
        <table>
          <thead><tr><th>When</th><th>Folder</th><th>Local commit</th><th>ZIP</th></tr></thead>
          <tbody>
            {state.exports.map((e: any) => (
              <tr key={e.id}>
                <td>{fmt(e.created_at)}</td>
                <td className="mono small">{e.folder}</td>
                <td className="mono">{e.commit_sha ? e.commit_sha.slice(0, 10) : "-"}</td>
                <td><a href={`/api/download?export=${e.id}`}>Download ZIP</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Kept out of the page: a small link, with the record in a dialog. */
function AuditLog({ audit }: { audit: any[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button className="quiet" onClick={() => dialog.current?.showModal()}>Activity log ({audit.length})</button>
      <dialog ref={dialog} className="audit-dialog" aria-label="Activity log">
        <div className="row tight between">
          <h2>Activity log</h2>
          <button className="secondary small-btn" onClick={() => dialog.current?.close()}>Close</button>
        </div>
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {audit.map((a, i) => (
              <tr key={i}><td>{fmt(a.ts)}</td><td>{a.actor}</td><td>{a.action}</td><td className="mono small">{a.details_json}</td></tr>
            ))}
          </tbody>
        </table>
      </dialog>
    </>
  );
}
