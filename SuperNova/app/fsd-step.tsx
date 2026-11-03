"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { applySectionChanges, diffLines, nextVersionLabel, openQuestions, parseFsd, type FsdDiff, type FsdSection } from "@/lib/fsd";
import { docxLink, fetchJson, fmt, pdfLink, renderMarkdown, statusLabel, type State, type StepProps } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tab = "preview" | "edit" | "compare" | "history";
type FsdProps = StepProps & { versionId: number | null; setVersionId: (id: number | null) => void; kind?: "FS" | "TS" };

/** One screen for both documents. For the TS it sees the TS versions, and its actions carry docType "TS". */
export function FsdStep({ state: page, busy, run: pageRun, go, versionId, setVersionId, kind = "FS" }: FsdProps) {
  const technical = kind === "TS";
  const state = technical ? { ...page, fsd: page.ts, fsdVersions: page.tsVersions, fsdChange: page.tsChange } : page;
  const run = (action: string, label: string, payload: Record<string, unknown> = {}) =>
    pageRun(technical && action === "generateFsd" ? "generateTs" : action, label, { ...payload, docType: kind });
  const r = state.requirement;
  const latest = state.fsd;
  const workflow = r.wricef === "W";
  const name = r.summary?.program_name ?? r.summary?.workflow_name ?? `REQ-${r.id}`;
  const [tab, setTab] = useState<Tab>("preview");
  const [viewed, setViewed] = useState<{ id: number; label: string; status: string; markdown: string } | null>(null);
  const [modify, setModify] = useState<{ prefill: string; baseId: number | null } | null>(null);
  const openModify = (prefill = "", baseId: number | null = null) => {
    setModify({ prefill, baseId });
    setTab("preview");
  };

  useEffect(() => setTab("preview"), [latest?.id]); // a new version always opens in the preview
  useEffect(() => {
    if (!versionId || versionId === latest?.id) return setViewed(null);
    let live = true;
    fetchJson(`/api/fsd?id=${versionId}`).then((v) => live && setViewed(v)).catch(() => live && setVersionId(null));
    return () => {
      live = false;
    };
  }, [versionId, latest?.id]);

  if (!r.summary) return null;
  if (!latest) return technical ? <NoTsYet state={page} busy={busy} run={run} /> : <NoFsdYet state={state} busy={busy} run={run} go={go} />;
  const stale = technical && (latest.status === "SUPERSEDED" || latest.fs_version_id !== page.fsd?.id);

  const doc = viewed ?? latest;
  const isLatest = doc.id === latest.id;
  const parsed = parseFsd(doc.markdown);

  return (
    <>
      <div className="card head-card">
        <div>
          <h1>{r.summary.title ?? r.title}</h1>
          <p className="muted">
            <span className="pill accent">{workflow ? "Workflow (W)" : "Report (R)"}</span> {technical ? "Technical specification" : "Functional specification"} · {name} · v{doc.label} · {parsed.sections.length} sections
            {technical && doc.fs_version_id && ` · from FS v${page.fsdVersions.find((v: any) => v.id === doc.fs_version_id)?.label ?? "?"}`}
          </p>
        </div>
        <div className="head-actions">
          <button
            className="secondary"
            onClick={() =>
              confirm(technical
                ? "Rewrite the whole TS from the approved FS as a new major version? Existing versions are kept."
                : "Rewrite the whole FS from the requirement summary as a new major version? Existing versions are kept.") &&
              run("generateFsd", technical ? "TS Generator agent is writing the TS" : "FS Generator agent is writing the FS")}
            disabled={busy || (technical && page.fsd?.status !== "APPROVED")}
          >
            Regenerate {kind}
          </button>
          <button className="secondary" onClick={() => openModify()} disabled={busy}>Modify {kind}</button>
          <a className="button secondary" href={docxLink(doc.id)}>Download DOCX</a>
          <a className="button secondary" href={pdfLink(doc.id)}>Download PDF</a>
          {!technical && latest.status === "DRAFT" && <button onClick={() => go(2)}>Next: Approval</button>}
          {!technical && latest.status === "APPROVED" && <button onClick={() => go(3)}>Next: Technical spec</button>}
          {technical && latest.status === "DRAFT" && !stale && (
            <button onClick={() => pageRun("approve", "Recording TS approval", { fsdVersionId: latest.id })} disabled={busy}>Approve TS v{latest.label}</button>
          )}
          {technical && latest.status === "APPROVED" && <button onClick={() => go(4)}>{workflow ? "Next: Deliverables" : "Next: ABAP code"}</button>}
        </div>
      </div>

      {stale && (
        <div className="notice">
          <span>This TS was written from an earlier FS version. The FS has changed since, so write a new TS before it can be approved.</span>
          <span className="spacer" />
          <button onClick={() => run("generateFsd", "TS Generator agent is writing the TS")} disabled={busy || page.fsd?.status !== "APPROVED"}>Write new TS</button>
        </div>
      )}

      {(modify || state.fsdChange) && (
        <ModifyPanel key={modify?.prefill ?? "open"} state={state} busy={busy} run={run} prefill={modify?.prefill ?? ""} baseId={modify?.baseId ?? null} onClose={() => setModify(null)} />
      )}

      <div className="tabs" role="tablist">
        {(["preview", "edit", "compare", "history"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} disabled={t === "edit" && !isLatest} onClick={() => setTab(t)}>
            {{ preview: "Preview", edit: "Edit", compare: "Compare versions", history: "Version history" }[t]}
          </button>
        ))}
      </div>

      {!isLatest && (
        <div className="notice">
          <span>You are viewing <b>v{doc.label}</b> ({statusLabel(doc.status)}). Older versions are read-only.</span>
          <span className="spacer" />
          <button className="secondary" onClick={() => setVersionId(null)}>Back to latest</button>
          <button className="secondary" onClick={() => openModify("", doc.id)} disabled={busy}>New version from this</button>
        </div>
      )}

      {tab === "preview" && <SectionList state={state} doc={doc} isLatest={isLatest} busy={busy} run={run} onRegenerate={(s) => openModify(`Rewrite section "${s.title}": `)} />}
      {tab === "edit" && <FullEditor state={state} busy={busy} run={run} />}
      {tab === "compare" && <Compare versions={state.fsdVersions} />}
      {tab === "history" && (
        <History
          state={state}
          busy={busy}
          onView={(id) => {
            setVersionId(id);
            setTab("preview");
          }}
          onBranch={(id) => openModify("", id)}
          onEdit={() => {
            setVersionId(null);
            setTab("edit");
          }}
        />
      )}
    </>
  );
}

/** Before the FS is written: the collected requirement is shown back and confirmed, facts apart from assumptions. */
function NoFsdYet({ state, busy, run, go }: Pick<StepProps, "state" | "busy" | "run" | "go">) {
  const r = state.requirement;
  const s = r.summary;
  const facts: string[] = s.business_facts ?? [];
  const assumptions: string[] = s.assumptions ?? [];
  const open: string[] = s.open_questions ?? [];
  const { coverage = [], contradictions = [] } = r.interview ?? {};
  return (
    <div className="card">
      <h2>Confirm the requirement</h2>
      <p className="muted">
        Check what the interview collected for this {r.wricef === "W" ? "workflow" : "report"}. The FS is written from it and becomes version 1.0.
        {state.revisions?.length > 0 && ` Requirement revision ${state.revisions[0].revision}.`}
      </p>
      {contradictions.length > 0 && (
        <div className="notice"><span><b>Still contradictory:</b> {contradictions.join(" ")}</span></div>
      )}
      <Coverage items={coverage} />
      <div className="confirm-grid">
        <div>
          <h4>What you told us</h4>
          {facts.length ? <ul>{facts.map((f) => <li key={f}>{f}</li>)}</ul> : <p className="muted small">Nothing recorded separately.</p>}
        </div>
        <div>
          <h4>Assumed for you</h4>
          {assumptions.length ? <ul>{assumptions.map((f) => <li key={f}>{f}</li>)}</ul> : <p className="muted small">No assumptions.</p>}
          {open.length > 0 && (<><h4>Still open</h4><ul>{open.map((f) => <li key={f}>{f}</li>)}</ul></>)}
        </div>
      </div>
      <div className="row">
        <button onClick={() => run("generateFsd", "FS Generator agent is writing the FS")} disabled={busy}>Confirm and write the FS</button>
        <button className="secondary" onClick={() => go(0)} disabled={busy}>Revise an answer</button>
      </div>
      <details>
        <summary>Full requirement summary</summary>
        <Summary data={s} />
      </details>
    </div>
  );
}

function NoTsYet({ state, busy, run }: Pick<StepProps, "state" | "busy" | "run">) {
  const fs = state.fsd;
  const approved = fs?.status === "APPROVED";
  const workflow = state.requirement.wricef === "W";
  return (
    <div className="card">
      <h2>Technical specification</h2>
      <p className="muted">
        {approved
          ? `The TS is written from the approved FS v${fs.label} and becomes TS version 1.0. It has its own versions and its own approval.`
          : "Approve the FS first. The TS is always written from an approved FS version."}
      </p>
      {workflow && <p className="muted small">For a workflow the TS is a technical design: trigger and event design, workflow steps, agent rules, deadlines, exception handling and an implementation plan. SuperNova does not create the workflow objects in SAP.</p>}
      <div className="row">
        <button onClick={() => run("generateFsd", "TS Generator agent is writing the TS")} disabled={busy || !approved}>Write the TS</button>
      </div>
    </div>
  );
}

export function Coverage({ items }: { items: { topic: string; state: string }[] }) {
  if (!items.length) return null;
  const label: Record<string, string> = { answered: "Answered", assumed: "Assumed", open: "Open" };
  return (
    <ul className="coverage">
      {items.map((c) => (
        <li key={c.topic} className={c.state}><span className="dot" aria-hidden />{c.topic}<em>{label[c.state] ?? c.state}</em></li>
      ))}
    </ul>
  );
}

export function Summary({ data }: { data: Record<string, unknown> }) {
  return (
    <dl className="summary">
      {Object.entries(data).map(([k, v]) => (
        <div key={k}>
          <dt>{k.replace(/_/g, " ")}</dt>
          <dd>
            {Array.isArray(v) ? (
              <ul>
                {v.map((x, i) => (
                  <li key={i}>{typeof x === "object" ? Object.values(x as object).filter((y) => y !== "").join(" · ") : String(x)}</li>
                ))}
              </ul>
            ) : typeof v === "object" && v ? (
              JSON.stringify(v)
            ) : (
              String(v)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- Modify FSD
function ModifyPanel({ state, busy, run, prefill, baseId, onClose }: Pick<StepProps, "state" | "busy" | "run"> & { prefill: string; baseId: number | null; onClose: () => void }) {
  const change = state.fsdChange;
  const latest = state.fsd;
  const [text, setText] = useState(prefill);
  const [type, setType] = useState<"MINOR" | "MAJOR" | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);

  const proposal = change?.proposal;
  const changeType = type ?? (proposal?.change_type === "major" ? "MAJOR" : "MINOR");
  const docName = latest.doc_type === "TS" ? "TS" : "FS";
  const base = state.fsdVersions.find((v: any) => v.id === (change?.base_version_id ?? baseId ?? latest.id));
  const failed = change && !proposal && change.conversation[change.conversation.length - 1]?.role === "user";

  const send = async () => {
    await run("proposeChange", "Reading the FSD and working out what changes", { text, changeId: change?.id, fsdVersionId: base.id });
    setText("");
    setType(null);
  };

  return (
    <div className="card modify">
      <div className="row tight">
        <h2>Modify {docName}</h2>
        <span className="pill accent">Based on v{base.label}</span>
        <span className="spacer" />
        {!change && <button className="secondary small-btn" onClick={onClose}>Cancel</button>}
      </div>
      <p className="muted">Describe the change. You will see what the AI plans to do before anything is written, and v{base.label} stays exactly as it is.</p>

      {change?.conversation.length > 0 && (
        <div className="chat">
          {change.conversation.map((m: any, i: number) => (
            <div key={i} className={`msg ${m.role}`}>
              <p>{m.content}</p>
            </div>
          ))}
        </div>
      )}

      {proposal && (
        <div className="proposal">
          <b>Sections that will change</b>
          <ul>
            {proposal.affected_sections.map((s: any) => <li key={s.heading}><b>{s.heading}</b>: {s.why}</li>)}
            {proposal.new_sections.map((s: string) => <li key={s}><b>{s}</b>: new section</li>)}
          </ul>
          <p className="muted small">All other sections stay word for word.</p>
          {latest.status === "APPROVED" && <p className="warn small">v{latest.label} is approved. A new version goes back to draft and needs approval again.</p>}
          <div className="row">
            <button
              onClick={async () => {
                await run("applyChange", "Writing the new version", { changeId: change.id, changeType });
                onClose();
              }}
              disabled={busy}
            >
              Generate v{nextVersionLabel(latest.label, changeType)}
            </button>
            <label className="muted small">
              Version type{" "}
              <select value={changeType} onChange={(e) => setType(e.target.value as "MINOR" | "MAJOR")} disabled={busy}>
                <option value="MINOR">Minor</option>
                <option value="MAJOR">Major</option>
              </select>
            </label>
            <span className="spacer" />
            <button
              className="secondary"
              onClick={async () => {
                await run("discardChange", "Discarding", { changeId: change.id });
                onClose();
              }}
              disabled={busy}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {failed && (
        <div className="row">
          <button onClick={() => run("proposeChange", "Trying again", { changeId: change.id })} disabled={busy}>Try again</button>
          <span className="muted small">Your request is saved.</span>
          <span className="spacer" />
          <button className="secondary" onClick={() => run("discardChange", "Discarding", { changeId: change.id }).then(onClose)} disabled={busy}>Discard</button>
        </div>
      )}

      <textarea
        ref={box}
        rows={proposal ? 2 : 3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={proposal ? "Not quite right? Say what to adjust." : "For example: add an approval workflow before purchase orders are finalized."}
      />
      <div className="row">
        <button className={proposal ? "secondary" : ""} onClick={send} disabled={busy || !text.trim()}>{proposal ? "Refine" : "Review change"}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Sections
function SectionList({ state, doc, isLatest, busy, run, onRegenerate }: Pick<StepProps, "state" | "busy" | "run"> & { doc: any; isLatest: boolean; onRegenerate: (s: FsdSection) => void }) {
  const parsed = useMemo(() => parseFsd(doc.markdown), [doc.markdown]);
  const version = state.fsdVersions.find((v: any) => v.id === doc.id);
  const changed = new Map<string, string>((version?.sections_changed ?? []).map((s: any) => [s.title, s.status]));
  const resolved = new Set<string>(state.annotations.filter((a: any) => a.kind === "RESOLVED").map((a: any) => a.section));
  const questions = openQuestions(doc.markdown);
  const save = (s: FsdSection, text: string) =>
    run("saveFsd", "Saving a new version", {
      text: applySectionChanges(doc.markdown, [{ heading: s.heading, action: "replace", markdown: text }]),
      summary: `Edited section "${s.title}"`,
    });

  return (
    <>
      {parsed.sections.map((s, i) =>
        s.key === "openquestions" && questions.length > 0 ? (
          <div key={s.key} className="card section questions">
            <div className="section-head">
              <span className="index">{i + 1}</span>
              <h3>{s.title}</h3>
              <span className={`pill ${questions.some((q) => !resolved.has(q)) ? "draft" : "good"}`}>{questions.filter((q) => !resolved.has(q)).length} open</span>
            </div>
            {questions.map((q) => (
              <div key={q} className={`question ${resolved.has(q) ? "resolved" : ""}`}>
                <span>{q}</span>
                <button className="secondary small-btn" onClick={() => run("resolveQuestion", "Saving", { text: q, fsdVersionId: doc.id, resolved: !resolved.has(q) })} disabled={busy}>
                  {resolved.has(q) ? "Reopen" : "Mark resolved"}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <SectionCard
            key={s.key}
            section={s}
            index={i + 1}
            badge={changed.get(s.title) ? `${changed.get(s.title) === "added" ? "New" : "Edited"} in v${doc.label}` : ""}
            comments={state.annotations.filter((a: any) => a.kind === "COMMENT" && a.section === s.key)}
            versions={state.fsdVersions}
            editable={isLatest}
            busy={busy}
            onSave={(text) => save(s, text)}
            onRegenerate={() => onRegenerate(s)}
            onComment={(text) => run("addComment", "Saving comment", { fsdVersionId: doc.id, section: s.key, text })}
          />
        ),
      )}
    </>
  );
}

function SectionCard({ section, index, badge, comments, versions, editable, busy, onSave, onRegenerate, onComment }: {
  section: FsdSection; index: number; badge: string; comments: any[]; versions: any[]; editable: boolean; busy: boolean;
  onSave: (text: string) => Promise<void>; onRegenerate: () => void; onComment: (text: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"read" | "edit" | "comment">("read");
  const [text, setText] = useState("");
  const html = useMemo(() => renderMarkdown(section.body), [section.body]);
  const labelOf = (id: number) => versions.find((v) => v.id === id)?.label;

  return (
    <div className="card section">
      <div className="section-head">
        <span className="index">{index}</span>
        <h3>{section.title}</h3>
        {badge ? <span className="pill accent">{badge}</span> : <span className="pill good">Ready</span>}
        <span className="spacer" />
        {editable && (
          <div className="section-actions">
            <button className="secondary small-btn" onClick={() => { setText(section.raw.trimEnd()); setMode("edit"); }} disabled={busy}>Edit</button>
            <button className="secondary small-btn" onClick={onRegenerate} disabled={busy}>Regenerate</button>
            <button className="secondary small-btn" onClick={() => { setText(""); setMode("comment"); }} disabled={busy}>Comment</button>
          </div>
        )}
      </div>

      {mode === "edit" ? (
        <>
          <textarea className="section-editor" rows={Math.min(24, section.raw.split("\n").length + 2)} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          <div className="row">
            <button onClick={() => onSave(text).then(() => setMode("read"))} disabled={busy || text.trim() === section.raw.trim()}>Save as new version</button>
            <button className="secondary" onClick={() => setMode("read")}>Cancel</button>
          </div>
        </>
      ) : (
        <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
      )}

      {mode === "comment" && (
        <>
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment for this section" autoFocus />
          <div className="row">
            <button onClick={() => onComment(text).then(() => setMode("read"))} disabled={busy || !text.trim()}>Add comment</button>
            <button className="secondary" onClick={() => setMode("read")}>Cancel</button>
          </div>
        </>
      )}

      {comments.map((c) => (
        <div key={c.id} className="comment">
          <span className="muted small">{c.author} · v{labelOf(c.fsd_version_id)} · {fmt(c.created_at)}</span>
          <p>{c.text}</p>
        </div>
      ))}
    </div>
  );
}

function FullEditor({ state, busy, run }: Pick<StepProps, "state" | "busy" | "run">) {
  const fsd = state.fsd;
  const [draft, setDraft] = useState(fsd.markdown);
  const [summary, setSummary] = useState("");
  useEffect(() => setDraft(fsd.markdown), [fsd.id, fsd.markdown]);
  const dirty = draft !== fsd.markdown;
  return (
    <div className="card">
      <p className="muted">Saving never changes v{fsd.label}. It creates v{nextVersionLabel(fsd.label, "MINOR")}.</p>
      <textarea className="fsd-editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
      <div className="row">
        <input type="text" className="grow" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What changed? (optional)" />
        {dirty && <span className="warn">Unsaved changes</span>}
        <button onClick={() => run("saveFsd", "Saving FSD version", { text: draft, summary })} disabled={busy || !dirty}>Save as new version</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ Version history
function History({ state, busy, onView, onBranch, onEdit }: { state: State; busy: boolean; onView: (id: number) => void; onBranch: (id: number) => void; onEdit: () => void }) {
  return (
    <div className="card">
      <h2>Version history</h2>
      <div className="history">
        {state.fsdVersions.map((v: any, i: number) => (
          <div key={v.id} className={`history-row ${i === 0 ? "current" : ""}`}>
            <div className="history-main">
              <div className="row tight">
                <b className="version">v{v.label}</b>
                <span className={`pill ${v.status.toLowerCase()}`}>{statusLabel(v.status)}</span>
                {i === 0 && <span className="pill accent">Current</span>}
                <span className="muted small">{fmt(v.created_at)}</span>
              </div>
              <p>{v.change_summary}</p>
              <p className="muted small">
                {v.parent_label ? `Based on v${v.parent_label}` : "First version"}
                {v.sections_changed?.length > 0 && ` · Changed: ${v.sections_changed.map((s: any) => s.title).join(", ")}`}
              </p>
            </div>
            <div className="history-actions">
              <button className="secondary small-btn" onClick={() => onView(v.id)}>View</button>
              <a className="button secondary small-btn" href={docxLink(v.id)}>DOCX</a>
              <a className="button secondary small-btn" href={pdfLink(v.id)}>PDF</a>
              {i === 0 ? (
                <button className="secondary small-btn" onClick={onEdit} disabled={busy}>Continue editing</button>
              ) : (
                <button className="secondary small-btn" onClick={() => onBranch(v.id)} disabled={busy}>New version from this</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- Compare
function Compare({ versions }: { versions: any[] }) {
  const newest = versions[0];
  const [toId, setToId] = useState<number>(newest.id);
  const [fromId, setFromId] = useState<number>(newest.parent_id ?? versions[versions.length - 1].id);
  const [result, setResult] = useState<{ diff: FsdDiff } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setResult(null);
    setFailed(false);
    fetchJson(`/api/fsd?from=${fromId}&to=${toId}`).then((d) => live && setResult(d)).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [fromId, toId]);

  const picker = (value: number, set: (id: number) => void) => (
    <select value={value} onChange={(e) => set(Number(e.target.value))}>
      {versions.map((v) => <option key={v.id} value={v.id}>v{v.label} · {statusLabel(v.status)}</option>)}
    </select>
  );

  if (versions.length < 2) return <div className="card"><p className="muted">There is only one version so far. Use Modify FSD to create another, then compare them here.</p></div>;

  const diff = result?.diff;
  const changed = diff?.sections.filter((s) => s.status !== "unchanged") ?? [];
  const same = (diff?.sections.length ?? 0) - changed.length;
  return (
    <div className="card">
      <div className="row">
        <h2>Compare versions</h2>
        <span className="spacer" />
        {picker(fromId, setFromId)}
        <span className="muted">to</span>
        {picker(toId, setToId)}
      </div>
      {!diff && <p className="muted">{failed ? "Could not compare these versions. Try again in a moment." : "Comparing..."}</p>}
      {diff && (
        <>
          <div className="stat-row">
            <Stat kind="add" value={diff.requirements.added.length} label={`${plural(diff.requirements.added.length, "requirement")} added`} />
            <Stat kind="mod" value={diff.requirements.modified.length} label={`${plural(diff.requirements.modified.length, "requirement")} modified`} />
            <Stat kind="del" value={diff.requirements.removed.length} label={`${plural(diff.requirements.removed.length, "requirement")} removed`} />
            <Stat kind="" value={changed.length} label={`${plural(changed.length, "section")} changed`} />
          </div>
          {diff.requirements.added.map((q) => <Requirement key={q.id} kind="add" tag="Added" id={q.id} text={q.after} />)}
          {diff.requirements.modified.map((q) => <Requirement key={q.id} kind="mod" tag="Modified" id={q.id} before={q.before} text={q.after} />)}
          {diff.requirements.removed.map((q) => <Requirement key={q.id} kind="del" tag="Removed" id={q.id} text={q.before} />)}

          {changed.length === 0 && <p className="muted">These two versions have the same content.</p>}
          {changed.map((s) => (
            <details key={s.key} className="diff-section" open>
              <summary>
                {s.title}
                {s.area !== "Other" && <span className="pill accent">{s.area}</span>}
                <span className={`pill ${s.status === "removed" ? "bad" : s.status === "added" ? "good" : "draft"}`}>{s.status}</span>
              </summary>
              <div className="diff">
                {s.lines.filter((l) => l.op !== "same").map((l, i) => (
                  <div key={i} className={l.op}><span aria-hidden>{l.op === "add" ? "+" : "−"}</span>{l.text}</div>
                ))}
              </div>
            </details>
          ))}
          {same > 0 && <p className="muted small">{same} other {same === 1 ? "section is" : "sections are"} unchanged.</p>}
        </>
      )}
    </div>
  );
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

function Stat({ kind, value, label }: { kind: string; value: number; label: string }) {
  return <div className={`stat ${kind}`}><b>{value}</b><span>{label}</span></div>;
}

function Requirement({ kind, tag, id, text, before }: { kind: string; tag: string; id: string; text?: string; before?: string }) {
  // The ID has its own column here, so drop it and the table pipes from the text.
  const clean = (t = "") => t.replace(/^\|\s*/, "").replace(/\s*\|$/, "").replace(new RegExp(`^${id}\\s*\\|\\s*`), "").replace(/\s*\|\s*/g, " · ");
  const words = before !== undefined ? diffLines(clean(before).split(" "), clean(text).split(" ")) : null;
  return (
    <div className={`requirement ${kind}`}>
      <span className="req-tag">{tag}</span>
      <b>{id}</b>
      <p>{words ? words.map((w, i) => <span key={i} className={`w-${w.op}`}>{w.text} </span>) : clean(text)}</p>
    </div>
  );
}
