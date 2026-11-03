// The agents: each one is a prompt file + an output schema + one callLLM call.
import { callLLM, type ChatMessage } from "./llm";
import { loadPrompt } from "./prompts";
import { catalog, catalogForPrompt } from "./catalog";
import type { CheckIssue } from "./checks";
import type { SectionChange } from "./fsd";
import type { Wricef } from "./wricef";

export const MAX_QUESTIONS = 7; // 3 to 5 questions, and up to 2 follow-ups for contradictions and gaps
export const MIN_QUESTIONS = 3;

// ---------------------------------------------------------------- Interviewer
export type InterviewTurn = {
  status: "questions" | "complete";
  message: string;
  questions: string[];
  summary: Record<string, unknown> | null;
  coverage?: { topic: string; state: "answered" | "assumed" | "open" }[];
  contradictions?: string[];
};

const interviewSchema = {
  type: "object",
  required: ["status", "message", "questions", "summary"],
  properties: {
    status: { enum: ["questions", "complete"] },
    message: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    summary: { anyOf: [{ type: "null" }, { type: "object", required: ["title", "purpose"] }] },
    coverage: {
      type: "array",
      items: { type: "object", required: ["topic", "state"], properties: { topic: { type: "string" }, state: { enum: ["answered", "assumed", "open"] } } },
    },
    contradictions: { type: "array", items: { type: "string" } },
  },
};

/** With finish, the user asked to stop: no more questions, whatever the limit says. */
export async function interviewTurn(
  requirementText: string, transcript: ChatMessage[], questionsAsked: number, finish = false, wricef: Wricef = "R", context = "",
) {
  const remaining = finish ? 0 : Math.max(0, MAX_QUESTIONS - questionsAsked);
  const minimum = finish ? 0 : Math.max(0, MIN_QUESTIONS - questionsAsked);
  // Separate paths: a workflow is interviewed about approvals and agents, never about selection screens.
  const system = loadPrompt(wricef === "W" ? "interviewer-workflow" : "interviewer", { remaining_questions: remaining, minimum_questions: minimum });
  const opening = `Original requirement:\n${requirementText}${context ? `\n\n${context}` : ""}`;
  const messages: ChatMessage[] = [{ role: "user", content: opening }, ...transcript];

  let { json } = await callLLM<InterviewTurn>({ system, messages, jsonSchema: interviewSchema, tag: "interviewer" });
  let turn = json!;

  // Enforce the question limit and a consistent shape.
  if (turn.status === "questions" && remaining === 0) {
    ({ json } = await callLLM<InterviewTurn>({
      system,
      messages: [...messages, { role: "user", content: "The question limit is reached. Return status \"complete\" with the summary now." }],
      jsonSchema: interviewSchema,
      tag: "interviewer",
    }));
    turn = json!;
  }
  // Only "Enough, write the FSD" may end the interview before the minimum.
  if (turn.status === "complete" && minimum > 0) {
    ({ json } = await callLLM<InterviewTurn>({
      system,
      messages: [...messages, { role: "user", content: `Only ${questionsAsked} of at least ${MIN_QUESTIONS} questions are asked. Do not complete yet: return status "questions" with the next most useful question, on a topic not covered so far.` }],
      jsonSchema: interviewSchema,
      tag: "interviewer",
    }));
    turn = json!;
  }
  if (turn.status === "questions") turn.questions = turn.questions.slice(0, 1); // one at a time, even if the model sends more
  if (turn.status === "complete" && !turn.summary) throw new Error("Interviewer returned status complete without a summary.");
  return turn;
}

// -------------------------------------------------------------- FSD Generator
export async function generateFsd(summary: unknown, requirementText: string, wricef: Wricef = "R"): Promise<string> {
  const system = wricef === "W" ? loadPrompt("fsd-workflow") : loadPrompt("fsd", { catalog: catalogForPrompt() });
  const { text } = await callLLM({
    system,
    messages: [
      {
        role: "user",
        content: `Original requirement:\n${requirementText}\n\nStructured requirement summary from the interview:\n${JSON.stringify(summary, null, 2)}`,
      },
    ],
    tag: wricef === "W" ? "fsd-workflow" : "fsd",
  });
  return text.trim() + "\n";
}

/** The TS is written from the approved FS, never from the interview alone. */
export async function generateTs(fsMarkdown: string, summary: unknown, wricef: Wricef, fsLabel: string): Promise<string> {
  const system = wricef === "W"
    ? loadPrompt("ts-workflow", { fs_version: fsLabel })
    : loadPrompt("ts-report", { fs_version: fsLabel, catalog: catalogForPrompt() });
  const { text } = await callLLM({
    system,
    messages: [{ role: "user", content: `Approved FS (version ${fsLabel}):\n\n${fsMarkdown}\n\nRequirement summary from the interview:\n${JSON.stringify(summary, null, 2)}` }],
    tag: wricef === "W" ? "ts-workflow" : "ts-report",
  });
  return text.trim() + "\n";
}

// ------------------------------------------------------------------ Modify FSD
export type FsdChangePlan = {
  understood: string;
  explanation: string;
  affected_sections: { heading: string; why: string }[];
  new_sections: string[];
  change_type: "minor" | "major";
};

const planSchema = {
  type: "object",
  required: ["understood", "explanation", "affected_sections", "new_sections", "change_type"],
  properties: {
    understood: { type: "string", minLength: 1 },
    explanation: { type: "string", minLength: 1 },
    affected_sections: {
      type: "array",
      items: { type: "object", required: ["heading", "why"], properties: { heading: { type: "string" }, why: { type: "string" } } },
    },
    new_sections: { type: "array", items: { type: "string" } },
    change_type: { enum: ["minor", "major"] },
  },
};

const applySchema = {
  type: "object",
  required: ["summary", "sections"],
  properties: {
    summary: { type: "string", minLength: 1 },
    sections: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["heading", "action", "markdown"],
        properties: { heading: { type: "string", minLength: 1 }, action: { enum: ["replace", "add", "remove"] }, markdown: { type: "string" } },
      },
    },
  },
};

const fsdContext = (markdown: string, docType = "FS"): ChatMessage => ({
  role: "user",
  content: `Current ${docType === "TS" ? "Technical Specification (TS)" : "Functional Specification (FS)"}:\n\n${markdown}`,
});

export async function planFsdChange(markdown: string, conversation: ChatMessage[], docType = "FS"): Promise<FsdChangePlan> {
  const { json } = await callLLM<FsdChangePlan>({
    system: loadPrompt("fsd-plan", { catalog: catalogForPrompt() }),
    messages: [fsdContext(markdown, docType), ...conversation],
    jsonSchema: planSchema,
    tag: "fsd-plan",
  });
  return json!;
}

export async function applyFsdChangePlan(markdown: string, conversation: ChatMessage[], plan: FsdChangePlan, docType = "FS") {
  const { json } = await callLLM<{ summary: string; sections: SectionChange[] }>({
    system: loadPrompt("fsd-apply", { catalog: catalogForPrompt() }),
    messages: [fsdContext(markdown, docType), ...conversation, { role: "user", content: `Confirmed. Apply this plan:\n${JSON.stringify(plan)}` }],
    jsonSchema: applySchema,
    tag: "fsd-apply",
  });
  return json!;
}

// ------------------------------------------------------------------ Dev Agent
export type GeneratedProgram = {
  program_name: string;
  title: string;
  abap_source: string;
  selection_texts: { key: string; text: string }[];
};

const programSchema = {
  type: "object",
  required: ["program_name", "title", "abap_source", "selection_texts"],
  properties: {
    program_name: { type: "string", pattern: "^[ZYzy][A-Za-z0-9_]{1,29}$" },
    title: { type: "string", minLength: 1, maxLength: 70 },
    abap_source: { type: "string", minLength: 20 },
    selection_texts: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "text"],
        properties: { key: { type: "string", maxLength: 8 }, text: { type: "string", maxLength: 30 } },
      },
    },
  },
};

function devPrompt() {
  return loadPrompt("dev", { catalog: catalogForPrompt(), abap_version: process.env.ABAP_VERSION || "v757" });
}

/**
 * Fixes slips that have exactly one correct form, so they never reach the checks or cost a repair pass:
 *  - An indented `*` line is not a comment in ABAP. It glues onto the next statement, and the colon of
 *    "* FR-01: ..." turns that statement into a chain, so one line gives one parser error per comma.
 *  - CALL TRANSACTION takes WITH AUTHORITY-CHECK before AND SKIP FIRST SCREEN.
 *  - DATA( ) is for inline declarations; with an explicit TYPE it has to be a plain DATA.
 *  - ( @s_x IS INITIAL OR f IN @s_x ) is invalid, and f IN @s_x alone already means the same.
 *  - A field list INTO TABLE fills by position, so a full-row target needs CORRESPONDING.
 *  - LOOP ... WHERE cannot call line_exists( ), so the test moves to a CHECK inside the loop.
 *  - FIELD-SYMBOL(<x>) may declare <x> only once per FORM or METHOD.
 *  - DATA inside a loop is set up once, not once per pass, so a counter needs a CLEAR to restart.
 *  - TITLE t_b1 and COMMENT ... c_x declare those names themselves, so a DATA for them clashes.
 */
export function cleanAbap(src: string): string {
  let inStatement = false;
  const lines = src.split("\n").map((line) => {
    const code = line.trimStart();
    if (code === "" || code.startsWith('"')) return line;
    // Inside a statement a leading * is a multiplication, unless it is clearly one of our comments.
    if (code.startsWith("*")) return !inStatement || /^\*\s*(FR-\d|NOTE\b)/.test(code) ? code : line;
    inStatement = !/[.,:]$/.test(code.replace(/\s*".*$/, "").trimEnd());
    return line;
  });
  let text = lines
    .join("\n")
    .replace(/(CALL\s+TRANSACTION\s+\S+)\s+(AND\s+SKIP\s+FIRST\s+SCREEN)\s+(WITH(?:OUT)?\s+AUTHORITY-CHECK)/gi, "$1 $3 $2")
    .replace(/^(\s*DATA)\(\s*(\w+)\s*\)(\s+TYPE\b)/gim, "$1 $2$3")
    .replace(/\(\s*@(s_\w+)\s+IS\s+INITIAL\s+OR\s+([\w~]+\s+IN\s+@\1)\s*\)/gi, "$2")
    .replace(/^([ \t]*)(LOOP\s+AT\b[^.]*?)\s+AND\s+((?:NOT\s+)?line_exists\([^.]*?\))\s*\./gim, "$1$2.\n$1  CHECK $3.");
  text = dropScreenNames(resetLoopLocals(declareFieldSymbolsOnce(text)));
  for (const m of text.matchAll(/\b(\w+)\s+TYPE\s+(?:(?:STANDARD|SORTED|HASHED)\s+)?TABLE\s+OF\s+([\w/]+)(?![\w/-])/gi)) {
    if (!catalog().tables[m[2].toUpperCase()]) continue;
    text = text.replace(new RegExp(String.raw`\bINTO\s+TABLE\s+@${m[1]}\b`, "gi"), `INTO CORRESPONDING FIELDS OF TABLE @${m[1]}`);
  }
  return text;
}

function declareFieldSymbolsOnce(text: string): string {
  return text
    .split(/^(?=[ \t]*(?:FORM|METHOD)\s)/im)
    .map((block) => {
      const seen = new Set<string>();
      for (const list of block.matchAll(/\bFIELD-SYMBOLS\b[^.]*\./gi)) {
        for (const name of list[0].matchAll(/<\w+>/g)) seen.add(name[0].toLowerCase());
      }
      return block.replace(/FIELD-SYMBOL\(\s*(<\w+>)\s*\)/gi, (whole, name: string) => {
        if (seen.has(name.toLowerCase())) return name;
        seen.add(name.toLowerCase());
        return whole;
      });
    })
    .join("");
}

function dropScreenNames(text: string): string {
  const declared = [...text.matchAll(/\bTITLE\s+(\w+)/gi), ...text.matchAll(/\bCOMMENT\s+\/?\d*\(\d+\)\s+(\w+)/gi)];
  const names = new Set(declared.map((m) => m[1].toLowerCase()));
  return text.replace(/^[ \t]*DATA\s*:?\s*[^.]*\.[ \t]*\n/gim, (statement) => {
    const parts = statement.replace(/^[ \t]*DATA\s*:?\s*/i, "").replace(/\.\s*$/, "").split(",");
    const kept = parts.filter((p) => !names.has(p.trim().split(/\s+/)[0].toLowerCase()));
    if (kept.length === parts.length) return statement;
    return kept.length ? `DATA: ${kept.map((p) => p.trim()).join(",\n      ")}.\n` : "";
  });
}

function resetLoopLocals(text: string): string {
  let depth = 0;
  return text
    .split("\n")
    .flatMap((line, i, lines) => {
      if (/^\s*(LOOP\s+AT|DO\b|WHILE\b)/i.test(line)) depth++;
      else if (/^\s*(ENDLOOP|ENDDO|ENDWHILE)\b/i.test(line)) depth--;
      const local = depth > 0 && line.match(/^(\s*)DATA\s+(\w+)\s+TYPE\s+[^.:,]*?(?:\s+VALUE\s+(?:0|''|' '|``))?\s*\.\s*$/i);
      if (!local || /\bVALUE\b/i.test(line.replace(/\s+VALUE\s+(0|''|' '|``)\s*\.\s*$/i, "."))) return [line];
      const clear = `${local[1]}CLEAR ${local[2]}.`;
      return lines[i + 1]?.trim().toLowerCase() === clear.trim().toLowerCase() ? [line] : [line, clear];
    })
    .join("\n");
}

function normalizeProgram(p: GeneratedProgram): GeneratedProgram {
  return {
    program_name: p.program_name.toUpperCase(),
    title: p.title.trim(),
    abap_source: cleanAbap(p.abap_source.replace(/\r\n/g, "\n")),
    selection_texts: p.selection_texts.map((s) => ({ key: s.key.toUpperCase(), text: s.text.trim() })),
  };
}

export async function generateAbap(fsdMarkdown: string, tsMarkdown?: string): Promise<GeneratedProgram> {
  const ts = tsMarkdown ? `\n\nApproved Technical Specification (TS):\n\n${tsMarkdown}` : "";
  const { json } = await callLLM<GeneratedProgram>({
    system: devPrompt(),
    messages: [{ role: "user", content: `Approved FSD:\n\n${fsdMarkdown}${ts}` }],
    jsonSchema: programSchema,
    tag: "dev",
  });
  return normalizeProgram(json!);
}

export async function repairAbap(fsdMarkdown: string, program: GeneratedProgram, errors: CheckIssue[]): Promise<GeneratedProgram> {
  // Quote the offending line: a parser error alone ("go_alv") does not say what to change.
  const lines = program.abap_source.split("\n");
  const errorList = errors
    .map((e) => {
      const src = e.line ? lines[e.line - 1]?.trim() : "";
      return `- [${e.rule}]${e.line ? ` line ${e.line}` : ""}: ${e.message}${src ? `\n    source: ${src}` : ""}`;
    })
    .join("\n");
  const { json } = await callLLM<GeneratedProgram>({
    system: loadPrompt("repair", { dev_rules: devPrompt() }),
    messages: [
      {
        role: "user",
        content: `Approved FSD:\n\n${fsdMarkdown}\n\nProgram you generated (JSON):\n${JSON.stringify(program)}\n\nErrors from the rule-based checks:\n${errorList}`,
      },
    ],
    jsonSchema: programSchema,
    tag: "repair",
  });
  return normalizeProgram(json!);
}

// ---------------------------------------------------------------- Code Review
export type ReviewResult = {
  summary: string;
  findings: { severity: "high" | "medium" | "low"; line: number; title: string; detail: string; suggestion: string }[];
};

const reviewSchema = {
  type: "object",
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "line", "title", "detail", "suggestion"],
        properties: { severity: { enum: ["high", "medium", "low"] }, line: { type: "number" } },
      },
    },
  },
};

export async function reviewCode(fsdMarkdown: string, source: string, ruleIssues: CheckIssue[]): Promise<ReviewResult> {
  const numbered = source
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4)}  ${l}`)
    .join("\n");
  const known = ruleIssues.length ? ruleIssues.map((e) => `- [${e.rule}] ${e.message}`).join("\n") : "(none)";
  const { json } = await callLLM<ReviewResult>({
    system: loadPrompt("review"),
    messages: [
      {
        role: "user",
        content: `Approved FSD:\n\n${fsdMarkdown}\n\nIssues already reported by the rule-based checks:\n${known}\n\nABAP source with line numbers:\n${numbered}`,
      },
    ],
    jsonSchema: reviewSchema,
    tag: "review",
  });
  return json!;
}
