// Rule-based checks on generated ABAP. No LLM involved.
//  - catalog:         every table / field used must exist in catalog/sap-catalog.json
//  - abaplint:        syntax check (@abaplint/core) at ABAP_VERSION
//  - select-star:     SELECT * is not allowed
//  - authority-check: purchasing data needs AUTHORITY-CHECK; CALL TRANSACTION needs WITH AUTHORITY-CHECK
//  - drilldown:       parameter ID and transaction must match (BES->ME23N, VRT->ME33L, MAT->MM03);
//                     scheduling agreements must not be opened with ME23N only
//  - call-args:       a method call must not mix an unnamed argument with named ones
//  - inline-decl:     DATA( ) needs a type it can infer; CLEAR cannot declare
//  - select-target:   a SELECT field list must not land by position in a whole-table row;
//                     a select-option cannot be tested in a WHERE clause
//  - abapgit:         names and selection texts fit the abapGit / SAP limits
// The ABAP "parser" here is a statement splitter plus regexes: good enough for the
// report pattern we generate, not a full ABAP grammar (abaplint covers syntax).
import { Config, MemoryFile, Registry } from "@abaplint/core";
import { catalog } from "./catalog";
import { progXml } from "./abapgit";
import type { GeneratedProgram } from "./agents";

export type CheckRule =
  | "catalog" | "abaplint" | "select-star" | "authority-check" | "drilldown" | "call-args" | "inline-decl" | "select-target" | "abapgit";
export type CheckIssue = { rule: CheckRule; severity: "error" | "warning"; line?: number; message: string };
export type CheckReport = { issues: CheckIssue[]; errors: number; warnings: number; abaplint: "ok" | "unavailable"; ran_at: string };

type Stmt = { line: number; raw: string; upper: string; masked: string };

const PURCHASING_TABLES = new Set(["EKKO", "EKPO", "EKBE", "EKBZ"]);
const HISTORY_TABLES = new Set(["EKBE", "EKBZ"]);
const LOCAL_PREFIX = /^(TY_|TT_|GT_|GS_|GV_|GO_|GR_|LT_|LS_|LV_|LO_|LR_|LX_|S_|P_|C_|T_|<)/;
const SQL_WORDS = new Set([
  "AND", "OR", "NOT", "WHERE", "IN", "IS", "NULL", "INITIAL", "BETWEEN", "LIKE", "AS", "CASE", "WHEN", "THEN",
  "ELSE", "END", "CAST", "COALESCE", "DISTINCT", "SINGLE", "ASCENDING", "DESCENDING", "PRIMARY", "KEY", "EXISTS",
]);

export function runChecks(p: GeneratedProgram): CheckReport {
  const issues: CheckIssue[] = [];
  const stmts = splitStatements(p.abap_source);
  const locals = localNames(stmts);

  checkFormat(p, stmts, issues);
  const tablesUsed = checkSelects(stmts, issues);
  checkTypeRefs(stmts, locals, issues);
  checkTablesStatement(stmts, issues);
  checkAuthority(stmts, tablesUsed, issues);
  checkDrilldowns(stmts, issues);
  checkCallArgs(stmts, issues);
  checkSelectTargets(stmts, issues);
  const undeclared = checkInlineDecls(stmts, issues);
  const abaplint = runAbaplint(p, issues, undeclared);

  issues.sort((a, b) => (a.severity === b.severity ? (a.line ?? 0) - (b.line ?? 0) : a.severity === "error" ? -1 : 1));
  return {
    issues,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    abaplint,
    ran_at: new Date().toISOString(),
  };
}

// ------------------------------------------------------------- statement split
/** Splits ABAP into statements: comments removed, literals kept in `raw`/`upper`, masked as '?' in `masked`. */
export function splitStatements(src: string): Stmt[] {
  const out: Stmt[] = [];
  const text = src.replace(/\r\n/g, "\n");
  let raw = "";
  let masked = "";
  let startLine = 0;
  let line = 1;
  let atLineStart = true;

  const begin = () => {
    if (raw.trim() === "") startLine = line;
  };
  const finish = () => {
    const r = raw.replace(/\s+/g, " ").trim();
    if (r) out.push({ line: startLine, raw: r, upper: r.toUpperCase(), masked: masked.replace(/\s+/g, " ").trim().toUpperCase() });
    raw = "";
    masked = "";
  };

  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (atLineStart && ch === "*") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "\n") {
      line++;
      atLineStart = true;
      raw += " ";
      masked += " ";
      i++;
      continue;
    }
    atLineStart = false;
    if (ch === '"') {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "'" || ch === "`") {
      begin();
      let j = i + 1;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === ch) {
          if (text[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      raw += text.slice(i, j + 1);
      masked += `${ch}?${ch}`;
      i = j + 1;
      continue;
    }
    if (ch === "|") {
      begin();
      let j = i + 1;
      while (j < text.length && text[j] !== "|") {
        if (text[j] === "\\") j++;
        else if (text[j] === "\n") line++;
        j++;
      }
      raw += " '?' ";
      masked += " '?' ";
      i = j + 1;
      continue;
    }
    if (ch === ".") {
      finish();
      i++;
      continue;
    }
    if (!/\s/.test(ch)) begin();
    raw += ch;
    masked += ch;
    i++;
  }
  finish();
  return out;
}

/** Names declared in the program (types, data, parameters ...), so TYPE x-y on them is not a DDIC reference. */
function localNames(stmts: Stmt[]): Set<string> {
  const names = new Set<string>();
  for (const s of stmts) {
    const m = s.masked.match(/^(TYPES|DATA|CONSTANTS|CLASS-DATA|STATICS|PARAMETERS|SELECT-OPTIONS|FIELD-SYMBOLS)\b:?\s*(.*)$/);
    if (!m) continue;
    for (const part of m[2].split(",")) {
      const id = part.trim().match(/^(?:BEGIN OF\s+|END OF\s+)?(<?[A-Z_][A-Z0-9_]*>?)/);
      if (id) names.add(id[1]);
    }
  }
  return names;
}

// ---------------------------------------------------------------------- format
function checkFormat(p: GeneratedProgram, stmts: Stmt[], issues: CheckIssue[]) {
  if (!/^[ZY][A-Z0-9_]{1,29}$/.test(p.program_name)) {
    issues.push({ rule: "abapgit", severity: "error", message: `Program name ${p.program_name} must start with Z or Y, use A-Z, 0-9, _ and have at most 30 characters.` });
  }
  if (p.title.length > 70) issues.push({ rule: "abapgit", severity: "error", message: `Title is longer than 70 characters.` });

  const report = stmts.find((s) => /^(REPORT|PROGRAM)\b/.test(s.masked));
  const reportName = report?.masked.match(/^(?:REPORT|PROGRAM)\s+([A-Z0-9_\/]+)/)?.[1];
  if (!report) issues.push({ rule: "abapgit", severity: "error", line: 1, message: "No REPORT statement found." });
  else if (reportName !== p.program_name) {
    issues.push({ rule: "abapgit", severity: "error", line: report.line, message: `REPORT ${reportName} does not match program_name ${p.program_name}.` });
  }

  const declared = new Map<string, number>();
  for (const s of stmts) {
    const m = s.masked.match(/^(PARAMETERS|SELECT-OPTIONS)\b:?\s*(.*)$/);
    if (!m) continue;
    for (const part of m[2].split(",")) {
      const id = part.trim().match(/^([A-Z_][A-Z0-9_]*)/);
      if (id) declared.set(id[1], s.line);
    }
  }
  const keys = new Set<string>();
  for (const t of p.selection_texts) {
    keys.add(t.key);
    if (!declared.has(t.key)) issues.push({ rule: "abapgit", severity: "error", message: `Selection text ${t.key} has no PARAMETERS / SELECT-OPTIONS of that name.` });
    if (t.key.length > 8) issues.push({ rule: "abapgit", severity: "error", message: `Selection text key ${t.key} is longer than 8 characters.` });
    if (t.text.length > 30) issues.push({ rule: "abapgit", severity: "error", message: `Selection text for ${t.key} is longer than 30 characters.` });
  }
  for (const [name, line] of declared) {
    if (name.length > 8) issues.push({ rule: "abapgit", severity: "error", line, message: `Selection screen name ${name} is longer than 8 characters.` });
    if (!/^[PS]_/.test(name)) {
      issues.push({ rule: "abapgit", severity: "error", line, message: `Selection screen field ${name} shows up as an input field for the user. Remove it, or name it p_ / s_ if it is real. For a radio button, put the radio PARAMETERS itself inside the BEGIN OF LINE, followed by its COMMENT.` });
    }
    if (!keys.has(name)) issues.push({ rule: "abapgit", severity: "warning", line, message: `No selection text returned for ${name}.` });
  }
}

// -------------------------------------------------------------------- catalog
function fieldExists(table: string, field: string) {
  return !!catalog().tables[table]?.fields[field];
}

function unknownField(table: string, field: string, line: number): CheckIssue {
  const known = Object.keys(catalog().tables[table]?.fields ?? {}).join(", ");
  return { rule: "catalog", severity: "error", line, message: `Field ${table}-${field} is not in the catalog. Known fields of ${table}: ${known}.` };
}

// "FIELDS" as a clause keyword, not the "INTO CORRESPONDING FIELDS OF" phrase.
const FIELDS_KW = String.raw`(?<!CORRESPONDING )\bFIELDS`;
const CLAUSE_END = String.raw`(?=\s+(?:WHERE|INTO|APPENDING|FOR\s+ALL\s+ENTRIES|(?<!CORRESPONDING )FIELDS|GROUP\s+BY|ORDER\s+BY|UP\s+TO|HAVING)\b|$)`;

/** Checks SELECT statements; returns the set of tables they read. */
function checkSelects(stmts: Stmt[], issues: CheckIssue[]): Set<string> {
  const used = new Set<string>();
  for (const s of stmts) {
    const m = s.masked;
    if (!/^SELECT\b/.test(m)) continue;

    if (/^SELECT\s+(SINGLE\s+)?(DISTINCT\s+)?\*/.test(m) || new RegExp(FIELDS_KW + String.raw`\s+\*`).test(m)) {
      issues.push({ rule: "select-star", severity: "error", line: s.line, message: "SELECT * is not allowed. List the fields you need." });
    }

    // Tables and aliases from the FROM clause
    const fromPart = m.match(new RegExp(String.raw`\bFROM\s+(.*?)` + CLAUSE_END))?.[1]?.replace(/[()]/g, " ") ?? "";
    const aliases = new Map<string, string>();
    const tables: string[] = [];
    const addTable = (t: string, alias?: string) => {
      tables.push(t);
      used.add(t);
      aliases.set(t, t);
      if (alias) aliases.set(alias, t);
      if (!catalog().tables[t]) issues.push({ rule: "catalog", severity: "error", line: s.line, message: `Table ${t} is not in the catalog.` });
    };
    const first = fromPart.match(/^\s*([A-Z0-9_\/]+)(?:\s+AS\s+([A-Z0-9_]+))?/);
    if (first) addTable(first[1], first[2]);
    for (const j of fromPart.matchAll(/\bJOIN\s+([A-Z0-9_\/]+)(?:\s+AS\s+([A-Z0-9_]+))?/g)) addTable(j[1], j[2]);
    const known = tables.filter((t) => catalog().tables[t]);

    // alias~field anywhere in the statement
    for (const t of m.matchAll(/([A-Z0-9_\/]+)~([A-Z0-9_]+)/g)) {
      const table = aliases.get(t[1]);
      if (table && catalog().tables[table] && !fieldExists(table, t[2])) issues.push(unknownField(table, t[2], s.line));
    }

    // Plain field names: field list, WHERE, GROUP BY, ORDER BY
    const plain: string[] = [];
    const fieldList =
      m.match(new RegExp(FIELDS_KW + String.raw`\s+(.*?)` + CLAUSE_END))?.[1] ??
      m.match(/^SELECT\s+(?:SINGLE\s+)?(?:DISTINCT\s+)?(.*?)\s+(?:FROM|INTO|APPENDING)\b/)?.[1] ??
      "";
    const cleaned = fieldList
      .replace(/\s+AS\s+[A-Z0-9_]+/g, " ")
      .replace(/\b(?:SUM|MIN|MAX|AVG|COUNT)\s*\(\s*(?:DISTINCT\s+)?/g, " ")
      .replace(/[()]/g, " ");
    for (const tok of cleaned.split(/[\s,]+/)) if (/^[A-Z_][A-Z0-9_]*$/.test(tok)) plain.push(tok);

    const where = m.match(/\bWHERE\s+(.*?)(?=\s+(?:INTO|APPENDING|GROUP\s+BY|ORDER\s+BY|UP\s+TO|HAVING)\b|$)/)?.[1] ?? "";
    for (const w of where.matchAll(/(?:^|[\s(])([A-Z_][A-Z0-9_]*)\s*(?:=|<>|<=|>=|<|>|\b(?:EQ|NE|LT|GT|LE|GE|IN|NOT|BETWEEN|LIKE|IS)\b)/g)) plain.push(w[1]);

    for (const clause of ["GROUP BY", "ORDER BY"]) {
      const part = m.match(new RegExp(String.raw`\b${clause.replace(" ", "\\s+")}\s+(.*?)(?=\s+(?:INTO|UP\s+TO|HAVING|ORDER\s+BY)\b|$)`))?.[1];
      if (part) for (const tok of part.split(/[\s,]+/)) if (/^[A-Z_][A-Z0-9_]*$/.test(tok)) plain.push(tok);
    }

    for (const f of plain) {
      if (SQL_WORDS.has(f) || known.length === 0) continue;
      if (known.length === 1) {
        if (!fieldExists(known[0], f)) issues.push(unknownField(known[0], f, s.line));
      } else if (!known.some((t) => fieldExists(t, f))) {
        issues.push({ rule: "catalog", severity: "error", line: s.line, message: `Field ${f} is not in any of the selected tables (${known.join(", ")}) in the catalog.` });
      }
    }
  }
  return used;
}

/** TYPE / LIKE / FOR table-field references. */
function checkTypeRefs(stmts: Stmt[], locals: Set<string>, issues: CheckIssue[]) {
  const re = /\b(?:TYPE|LIKE|FOR)\s+(?:(?:STANDARD|SORTED|HASHED)\s+)?(?:TABLE\s+OF\s+|RANGE\s+OF\s+|REF\s+TO\s+|LINE\s+OF\s+)?([A-Z_][A-Z0-9_\/]*)-([A-Z_][A-Z0-9_]*)\b/g;
  const warned = new Set<string>();
  for (const s of stmts) {
    for (const m of s.masked.matchAll(re)) {
      const [, prefix, field] = m;
      if (catalog().tables[prefix]) {
        if (!fieldExists(prefix, field)) issues.push(unknownField(prefix, field, s.line));
      } else if (!["SY", "SYST"].includes(prefix) && !locals.has(prefix) && !LOCAL_PREFIX.test(prefix) && !warned.has(prefix)) {
        warned.add(prefix);
        issues.push({ rule: "catalog", severity: "warning", line: s.line, message: `${prefix}-${field}: ${prefix} is not in the catalog, so this reference cannot be verified.` });
      }
    }
  }
}

function checkTablesStatement(stmts: Stmt[], issues: CheckIssue[]) {
  for (const s of stmts) {
    const m = s.masked.match(/^TABLES\b:?\s*(.*)$/);
    if (!m) continue;
    for (const t of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!catalog().tables[t]) issues.push({ rule: "catalog", severity: "error", line: s.line, message: `TABLES ${t}: table is not in the catalog.` });
    }
  }
}

// ------------------------------------------------------------------ authority
function checkAuthority(stmts: Stmt[], tablesUsed: Set<string>, issues: CheckIssue[]) {
  const checks = stmts.filter((s) => /^AUTHORITY-CHECK\s+OBJECT\b/.test(s.upper));
  const purchasing = [...tablesUsed].filter((t) => PURCHASING_TABLES.has(t));
  if (purchasing.length && checks.length === 0) {
    issues.push({
      rule: "authority-check",
      severity: "error",
      message: `The program reads purchasing data (${purchasing.join(", ")}) but has no AUTHORITY-CHECK. Check M_BEST_WRK (purchase orders) / M_RAHM_WRK (scheduling agreements) with ACTVT '03' per plant and drop rows the user may not see.`,
    });
  }
  for (const s of checks) {
    const obj = s.upper.match(/AUTHORITY-CHECK\s+OBJECT\s+'([^']+)'/)?.[1];
    if (obj && !catalog().authorization_objects[obj]) {
      issues.push({ rule: "authority-check", severity: "warning", line: s.line, message: `Authorization object ${obj} is not in the catalog.` });
    }
  }
  for (const s of stmts) {
    if (/^CALL\s+TRANSACTION\b/.test(s.upper) && !/\bWITH\s+AUTHORITY-CHECK\b/.test(s.upper)) {
      issues.push({ rule: "authority-check", severity: "error", line: s.line, message: "CALL TRANSACTION without WITH AUTHORITY-CHECK." });
    }
  }
}

// ------------------------------------------------------------------ drilldown
function checkDrilldowns(stmts: Stmt[], issues: CheckIssue[]) {
  const map = catalog().drilldowns;
  const tcodeOwner = new Map(Object.entries(map).map(([pid, d]) => [d.transaction, pid]));
  const called = new Set<string>();
  let lastParam: string | undefined;

  for (const s of stmts) {
    const set = s.upper.match(/^SET\s+PARAMETER\s+ID\s+'([^']+)'/);
    if (set) {
      lastParam = set[1];
      continue;
    }
    const call = s.upper.match(/^CALL\s+TRANSACTION\s+'([^']+)'/);
    if (!call) continue;
    const tcode = call[1];
    called.add(tcode);
    if (lastParam && map[lastParam] && map[lastParam].transaction !== tcode) {
      issues.push({ rule: "drilldown", severity: "error", line: s.line, message: `Parameter ID ${lastParam} belongs to ${map[lastParam].transaction}, but the program calls ${tcode}.` });
    } else if (!lastParam && tcodeOwner.has(tcode)) {
      issues.push({ rule: "drilldown", severity: "warning", line: s.line, message: `CALL TRANSACTION '${tcode}' without SET PARAMETER ID '${tcodeOwner.get(tcode)}' before it.` });
    }
    lastParam = undefined;
  }

  const selectsAgreements = stmts.some(
    (s) => /^SELECT\b/.test(s.upper) && (/\bBSTYP\s*(?:=|EQ)\s*'L'/.test(s.upper) || /\bBSTYP\s+IN\s*\(([^)]*'L'[^)]*)\)/.test(s.upper)),
  );
  if (selectsAgreements && called.has("ME23N") && !called.has("ME33L")) {
    issues.push({
      rule: "drilldown",
      severity: "error",
      message: "Scheduling agreements (BSTYP 'L') are selected, but the document drill-down only calls ME23N, which cannot display them. Branch on BSTYP: 'F' -> BES + ME23N, 'L' -> VRT + ME33L.",
    });
  }
}

// ------------------------------------------------------------------ call args
// ABAP accepts an unnamed argument only when it is the only one: meth( 'A' b = 1 ) does not parse.
// abaplint reports that as a bare parser_error on the first word, which gives the repair pass nothing to go on.
const ARG_KEYWORDS = new Set([
  "EXPORTING", "IMPORTING", "CHANGING", "RECEIVING", "EXCEPTIONS", "BASE", "WHEN", "FOR", "LET", "INIT", "NOT", "TABLE", "DEFAULT",
]);
const COLUMN_METHODS = new Set(["ADD_SORT", "ADD_AGGREGATION"]);

function checkCallArgs(stmts: Stmt[], issues: CheckIssue[]) {
  for (const s of stmts) {
    for (const m of s.masked.matchAll(/([A-Z0-9_]+)\(\s+('\?'|`\?`|[A-Z0-9_~-]+)\s+([A-Z_][A-Z0-9_]*)\s*=(?!>)/g)) {
      const [, method, first, named] = m;
      if (ARG_KEYWORDS.has(first)) continue;
      const meth = method.toLowerCase();
      const param = COLUMN_METHODS.has(method) ? "columnname" : "<parameter>";
      issues.push({
        rule: "call-args",
        severity: "error",
        line: s.line,
        message: `${meth}( ) mixes an unnamed argument with named ones (${named.toLowerCase()} = ...). ABAP allows an unnamed argument only when it is the only one, so name every argument: ${meth}( ${param} = ... ${named.toLowerCase()} = ... ).`,
      });
    }
  }
}

// --------------------------------------------------------------- inline-decl
/** Returns the names whose DATA( ) declaration is invalid: every later use of them fails too. */
function checkInlineDecls(stmts: Stmt[], issues: CheckIssue[]): Set<string> {
  const failed = new Set<string>();
  // abaplint accepts a field symbol that nothing ever points at, but the program dumps on first use.
  for (const s of stmts.filter((x) => /^FIELD-SYMBOLS\b/.test(x.masked))) {
    for (const [name] of s.masked.matchAll(/<\w+>/g)) {
      const others = stmts.filter((x) => x !== s && x.masked.includes(name));
      if (others.length && !others.some((x) => new RegExp(`\\b(?:TO|ASSIGNING)\\s+${name}`).test(x.masked))) {
        const lower = name.toLowerCase();
        issues.push({
          rule: "inline-decl",
          severity: "error",
          line: others[0].line,
          message: `${lower} is never assigned, so the program dumps here at runtime. Use a work area instead (DATA ls_out TYPE ty_out, then APPEND ls_out TO gt_out), or assign it first with APPEND INITIAL LINE TO gt_out ASSIGNING ${lower}.`,
        });
      }
    }
  }
  for (const s of stmts) {
    const typed = s.masked.match(/\b(?:DATA|FINAL)\(\s*([A-Z0-9_]+)\s*\)\s*=\s*(VALUE|NEW|CONV|CORRESPONDING|COND|SWITCH|REDUCE)\s+#/);
    if (typed) {
      const [, name, op] = typed;
      const lower = name.toLowerCase();
      failed.add(name);
      issues.push({
        rule: "inline-decl",
        severity: "error",
        line: s.line,
        message: `DATA(${lower}) = ${op} #( ... ): # has no type to infer from. Declare ${lower} first with DATA ${lower} TYPE ..., or name the type: DATA(${lower}) = ${op} <type>( ... ).`,
      });
    }
    const shortText = s.upper.match(/\bDATA\(\s*([A-Z0-9_]+)\s*\)\s*=\s*'\s*'/);
    if (shortText) {
      const lower = shortText[1].toLowerCase();
      issues.push({
        rule: "inline-decl",
        severity: "error",
        line: s.line,
        message: `DATA(${lower}) = '' creates a 1-character variable, so a later ${lower} = 'FREIGHT' is cut to 'F' and comparisons fail silently. Declare it with a length: DATA ${lower} TYPE c LENGTH 20, or DATA ${lower} TYPE string.`,
      });
    }
    const cleared = s.masked.match(/^(CLEAR|FREE)\b.*\bDATA\(\s*(<?[A-Z0-9_]+>?)\s*\)/);
    if (cleared) {
      const [, verb, name] = cleared;
      const lower = name.toLowerCase();
      failed.add(name);
      issues.push({
        rule: "inline-decl",
        severity: "error",
        line: s.line,
        message: `${verb} DATA(${lower}) is not valid: ${verb} cannot declare a variable. Declare it with DATA ${lower} TYPE ..., then ${verb} ${lower}.`,
      });
    }
  }
  return failed;
}

// ------------------------------------------------------------- select-target
// Neither shows up in abaplint: standard tables are void to it, and both only fail on a real system.
function checkSelectTargets(stmts: Stmt[], issues: CheckIssue[]) {
  const plainTables = new Set<string>();
  const wholeRow = new Map<string, string>();
  for (const s of stmts) {
    for (const m of s.masked.matchAll(/\b([A-Z_][A-Z0-9_]*)\s+TYPE\s+(?:(?:STANDARD|SORTED|HASHED)\s+)?TABLE\s+OF\s+([A-Z0-9_\/-]+)/g)) {
      plainTables.add(m[1]);
      if (catalog().tables[m[2]]) wholeRow.set(m[1], m[2]);
    }
  }
  for (const s of stmts) {
    // Same rule in SQL and in ABAP. "FOR x IN tab" and "FOR ALL ENTRIES IN tab" iterate, they do not compare.
    for (const m of s.masked.matchAll(/(?<!ENTRIES |\b(?:FOR|OF)\s+\S+\s)\bIN\s+(@?)([A-Z_][A-Z0-9_]*)/g)) {
      if (!plainTables.has(m[2])) continue;
      const lower = m[2].toLowerCase();
      issues.push({
        rule: "select-target",
        severity: "error",
        line: s.line,
        message: `field IN ${m[1]}${lower} needs a range table (sign, option, low, high), but ${lower} is a plain table. Declare it with TYPE RANGE OF ..., use FOR ALL ENTRIES in SQL, or line_exists( ${lower}[ table_line = field ] ) in ABAP.`,
      });
    }
    if (!/^SELECT\b/.test(s.masked)) continue;

    const target = s.masked.match(/\bINTO\s+TABLE\s+@([A-Z_][A-Z0-9_]*)/)?.[1];
    if (target && wholeRow.has(target) && !/^SELECT\s+(?:SINGLE\s+)?(?:DISTINCT\s+)?\*/.test(s.masked)) {
      const lower = target.toLowerCase();
      issues.push({
        rule: "select-target",
        severity: "error",
        line: s.line,
        message: `SELECT with a field list INTO TABLE @${lower} fills columns by position, but ${lower} has the full row of ${wholeRow.get(target)}, so values land in the wrong fields. Give ${lower} a local type with exactly these fields in this order, or use INTO CORRESPONDING FIELDS OF TABLE.`,
      });
    }

    for (const m of s.masked.matchAll(/@(S_[A-Z0-9_]+)\s+IS\s+(?:NOT\s+)?INITIAL/g)) {
      const lower = m[1].toLowerCase();
      issues.push({
        rule: "select-target",
        severity: "error",
        line: s.line,
        message: `@${lower} IS INITIAL is not valid in a WHERE clause: a select-option is an internal table. Remove the test; field IN @${lower} already matches everything when it is empty.`,
      });
    }

    if (!/\bFOR\s+ALL\s+ENTRIES\b/.test(s.masked)) continue;

    const expr = s.masked.match(/@([A-Z_][A-Z0-9_]*)\[/)?.[1]?.toLowerCase();
    if (expr) {
      issues.push({
        rule: "select-target",
        severity: "error",
        line: s.line,
        message: `FOR ALL ENTRIES cannot use a table expression (@${expr}[ ... ]). Compare with the column of the driver table: field = @${expr}-field.`,
      });
    }

    const table = s.masked.match(/\bFROM\s+([A-Z0-9_\/]+)/)?.[1] ?? "";
    if (!HISTORY_TABLES.has(table)) continue;
    const selected = s.masked.split(/\bWHERE\b/)[0];
    const missing = Object.entries(catalog().tables[table]?.fields ?? {})
      .filter(([name, f]) => f.key && name !== "MANDT" && !new RegExp(String.raw`\b${name}\b`).test(selected))
      .map(([name]) => name);
    if (missing.length) {
      issues.push({
        rule: "select-target",
        severity: "error",
        line: s.line,
        message: `FOR ALL ENTRIES removes identical rows, so a SELECT on ${table} must read its full primary key, or separate postings with the same values disappear and the totals are wrong. Missing: ${missing.join(", ")}. Add them to the field list and to the target type.`,
      });
    }
  }
}

// ------------------------------------------------------------------- abaplint
function runAbaplint(p: GeneratedProgram, issues: CheckIssue[], undeclared: Set<string>): "ok" | "unavailable" {
  // A call-args or inline-decl error already explains what abaplint reports on the same statement.
  const explained = new Set(issues.filter((i) => i.rule === "call-args" || i.rule === "inline-decl").map((i) => i.line));
  try {
    const conf = Config.getDefault().get();
    conf.syntax.version = (process.env.ABAP_VERSION || "v757") as typeof conf.syntax.version;
    conf.syntax.errorNamespace = "^(Z|Y|LCL_|TY_|LIF_)";
    conf.rules = { parser_error: true, check_syntax: true };
    const reg = new Registry(new Config(JSON.stringify(conf)));
    const name = p.program_name.toLowerCase();
    reg.addFile(new MemoryFile(`${name}.prog.abap`, p.abap_source));
    reg.addFile(new MemoryFile(`${name}.prog.xml`, progXml(p)));
    reg.parse();
    // One bad declaration makes every later use of the name fail. Report it once: the count stays
    // honest and the repair pass sees the cause, not 40 copies of the symptom.
    const uses = new Map<string, CheckIssue>();
    const counts = new Map<string, number>();
    for (const i of reg.findIssues()) {
      const line = i.getStart().getRow();
      if (["parser_error", "check_syntax"].includes(i.getKey()) && explained.has(line)) continue;
      const missing = i.getMessage().match(/^"([^"]+)" not found/)?.[1]?.toUpperCase();
      if (missing && undeclared.has(missing)) continue;
      if (missing && uses.has(missing)) {
        counts.set(missing, (counts.get(missing) ?? 1) + 1);
        continue;
      }
      const issue: CheckIssue = { rule: "abaplint", severity: "error", line, message: `${i.getKey()}: ${i.getMessage()}` };
      if (missing) uses.set(missing, issue);
      issues.push(issue);
    }
    for (const [name, n] of counts) uses.get(name)!.message += ` (${n} uses in total: fix the declaration of ${name.toLowerCase()})`;
    return "ok";
  } catch (e) {
    issues.push({ rule: "abaplint", severity: "warning", message: `abaplint could not run: ${(e as Error).message}` });
    return "unavailable";
  }
}
