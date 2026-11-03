// Self-test of the deterministic layer (no LLM): abapGit writer and rule-based
// checks, using the golden reference repo in fixtures/golden.
//   npm run selftest
import fs from "node:fs";
import path from "node:path";
import { serializeProgram, PACKAGE_DESCRIPTION } from "../lib/abapgit";
import { runChecks, type CheckReport } from "../lib/checks";
import JSZip from "jszip";
import { cleanAbap, type GeneratedProgram } from "../lib/agents";
import { buildFsdDocx } from "../lib/docx";
import { buildFsdPdf } from "../lib/pdf";
import { fitInto, imageSize } from "../lib/client";
import { CHOICES, otherTypeSigns } from "../lib/wricef";
import { drawFlow, flowPng, parseFlow } from "../lib/flow-diagram";
import { marked } from "marked";
import type { FsdVersion } from "../lib/db";
import { applySectionChanges, changedSections, diffFsd, joinFsd, nextVersionLabel, openQuestions, parseFsd, renumberFsd } from "../lib/fsd";

const golden = path.join(process.cwd(), "fixtures", "golden");
const read = (p: string) => fs.readFileSync(path.join(golden, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function expect(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failed++;
}
const has = (r: CheckReport, rule: string, text: string) =>
  r.issues.some((i) => i.severity === "error" && i.rule === rule && i.message.includes(text));
const errorsOf = (r: CheckReport, rule: string) => r.issues.filter((i) => i.severity === "error" && i.rule === rule);
const show = (r: CheckReport) => r.issues.map((i) => `${i.severity} [${i.rule}]${i.line ? ` L${i.line}` : ""} ${i.message}`).join("\n      ");

// Golden program as the Dev Agent would return it
const xml = read("src/zmm_landed_cost.prog.xml");
const prog: GeneratedProgram = {
  program_name: "ZMM_LANDED_COST",
  title: xml.match(/<ID>R<\/ID>\s*<ENTRY>([^<]*)<\/ENTRY>/)![1],
  abap_source: read("src/zmm_landed_cost.prog.abap"),
  selection_texts: [...xml.matchAll(/<ID>S<\/ID>\s*<KEY>([^<]*)<\/KEY>\s*<ENTRY>([^<]*)<\/ENTRY>/g)].map((m) => ({
    key: m[1],
    text: m[2].slice(8),
  })),
};

console.log("\n== abapGit writer vs golden files ==");
const files = Object.fromEntries(serializeProgram(prog).map((f) => [f.path, f.content]));
expect(".abapgit.xml identical", files[".abapgit.xml"] === read(".abapgit.xml"));
expect("zmm_landed_cost.prog.xml identical", files["src/zmm_landed_cost.prog.xml"] === xml);
expect(
  "package.devc.xml identical apart from description",
  files["src/package.devc.xml"] === read("src/package.devc.xml").replace("ALV Reports (abapGit)", PACKAGE_DESCRIPTION),
);
expect("zmm_landed_cost.prog.abap identical", files["src/zmm_landed_cost.prog.abap"] === prog.abap_source);

console.log("\n== Checks on the golden (reference) program ==");
const g = runChecks(prog);
console.log(`      ${show(g)}`);
expect("abaplint ran with 0 errors", g.abaplint === "ok" && errorsOf(g, "abaplint").length === 0);
expect("catalog: 0 errors", errorsOf(g, "catalog").length === 0);
expect("no SELECT *", errorsOf(g, "select-star").length === 0);
expect("select-target: 0 errors", errorsOf(g, "select-target").length === 0, show(g));
expect("inline-decl: 0 errors", errorsOf(g, "inline-decl").length === 0, show(g));
expect("flags missing AUTHORITY-CHECK on purchasing data", has(g, "authority-check", "no AUTHORITY-CHECK"));
expect("flags scheduling agreements opened with ME23N", has(g, "drilldown", "Scheduling agreements"));
expect("abapgit format: 0 errors", errorsOf(g, "abapgit").length === 0);

console.log("\n== Checks on a deliberately broken variant ==");
const broken: GeneratedProgram = {
  ...prog,
  abap_source: prog.abap_source
    .replace("SELECT ebeln, ebelp, zekkn, vgabe, gjahr, belnr, buzei,\n         shkzg, menge, dmbtr\n    FROM ekbe", "SELECT *\n    FROM ekbe")
    .replace("kschl TYPE ekbz-kschl", "kschl TYPE ekbz-zzcond")
    .replace("v~name1,", "v~name1, v~zzrating,")
    .replace("CALL TRANSACTION 'ME23N' WITH AUTHORITY-CHECK.", "CALL TRANSACTION 'ME22N'.")
    .replace("lv_amount = COND", "lv_amount = lv_undefined + COND")
    .replace("        columnname = 'BUKRS'\n", "        'BUKRS'\n"),
};
const b = runChecks(broken);
console.log(`      ${show(b)}`);
expect("SELECT * flagged", errorsOf(b, "select-star").length === 1);
expect("unknown field in TYPE (EKBZ-ZZCOND) flagged", has(b, "catalog", "EKBZ-ZZCOND"));
expect("unknown field in JOIN select (LFA1-ZZRATING) flagged", has(b, "catalog", "LFA1-ZZRATING"));
expect("ME22N after parameter BES flagged", has(b, "drilldown", "BES belongs to ME23N"));
expect("CALL TRANSACTION without authority check flagged", has(b, "authority-check", "without WITH AUTHORITY-CHECK"));
expect("abaplint finds undefined variable", has(b, "abaplint", "lv_undefined"));
const mixed = errorsOf(b, "call-args");
expect("unnamed + named argument in add_sort flagged with the fix", mixed.length === 1 && mixed[0].message.includes("add_sort( columnname = ..."), show(b));
expect("no duplicate parser_error on that statement", !b.issues.some((i) => i.rule === "abaplint" && i.line === mixed[0]?.line), show(b));

console.log("\n== call-args: valid calls are not flagged ==");
const valid = [
  "lo_col = lo_cols->get_column( 'EBELN' ).",
  "cl_salv_table=>factory( IMPORTING r_salv_table = go_alv CHANGING t_table = gt_out ).",
  "lo_obj->run( EXPORTING iv_a = 1 iv_b = 2 ).",
  "lv_text = COND #( WHEN lv_a = 1 THEN 'X' ELSE 'Y' ).",
  "lv_text = COND string( WHEN lv_a = 1 THEN 'X' ).",
  "ls_out = VALUE ty_out( BASE ls_out ebeln = '1' ).",
  "lv_sum = REDUCE i( INIT s = 0 FOR wa IN lt_tab NEXT s = s + wa ).",
  "lr_sorts->add_sort( columnname = 'BUKRS' subtotal = if_salv_c_bool_sap=>true ).",
  "IF ( lv_a = 1 ) AND lines( lt_tab ) = 0. ENDIF.",
];
const v = runChecks({ ...prog, abap_source: `REPORT zmm_landed_cost.\n${valid.join("\n")}\n` });
expect("no call-args errors on valid calls", errorsOf(v, "call-args").length === 0, show(v));

console.log("\n== cleanAbap: mechanical slips fixed, valid code untouched ==");
const dirty = [
  "FORM a.",
  "  CLEAR gt_out.",
  "",
  "  * FR-01, FR-02: read items",
  "  SELECT a, b FROM ekpo INTO TABLE @lt.",
  "  * Plain indented comment",
  "  CALL TRANSACTION 'MM03' AND SKIP FIRST SCREEN WITH AUTHORITY-CHECK.",
  "ENDFORM.",
].join("\n");
const cleaned = cleanAbap(dirty).split("\n");
expect("indented FR comment moved to column 1", cleaned[3] === "* FR-01, FR-02: read items", cleaned[3]);
expect("indented plain comment moved to column 1", cleaned[5] === "* Plain indented comment", cleaned[5]);
expect("CALL TRANSACTION clauses reordered", cleaned[6].includes("'MM03' WITH AUTHORITY-CHECK AND SKIP FIRST SCREEN."), cleaned[6]);
expect("DATA( ) with TYPE becomes plain DATA", cleanAbap("    DATA(lv_val) TYPE ekbe-wrbtr.\n") === "    DATA lv_val TYPE ekbe-wrbtr.\n");
expect("real inline declaration left alone", cleanAbap("  DATA(lv_val) = 1.\n") === "  DATA(lv_val) = 1.\n");
expect("select-option test in WHERE removed", cleanAbap("  AND ( @s_ebeln IS INITIAL OR a~ebeln IN @s_ebeln )\n") === "  AND a~ebeln IN @s_ebeln\n", cleanAbap("  AND ( @s_ebeln IS INITIAL OR a~ebeln IN @s_ebeln )\n"));
const rows = "DATA lt_makt TYPE STANDARD TABLE OF makt.\nDATA lt_x TYPE STANDARD TABLE OF ty_x.\nSELECT matnr, maktx FROM makt INTO TABLE @lt_makt.\nSELECT a FROM makt INTO TABLE @lt_x.\n";
expect("full-row target gets CORRESPONDING, local type does not", cleanAbap(rows).includes("INTO CORRESPONDING FIELDS OF TABLE @lt_makt.") && cleanAbap(rows).includes("INTO TABLE @lt_x."), cleanAbap(rows));
const loopWhere = "  LOOP AT lt_ekbz ASSIGNING FIELD-SYMBOL(<ls_ekbz>)\n    WHERE ebeln = lv_a\n      AND line_exists( lt_ct[ table_line = <ls_ekbz>-kschl ] ).\n    lv_x = 1.\n  ENDLOOP.\n";
expect("line_exists leaves the WHERE for a CHECK in the loop", cleanAbap(loopWhere).includes("WHERE ebeln = lv_a.\n    CHECK line_exists( lt_ct[ table_line = <ls_ekbz>-kschl ] ).\n"), cleanAbap(loopWhere));
const repeated = "FORM a.\n  LOOP AT lt ASSIGNING FIELD-SYMBOL(<x>).\n  ENDLOOP.\n  LOOP AT lt ASSIGNING FIELD-SYMBOL(<x>).\n  ENDLOOP.\nENDFORM.\nFORM b.\n  LOOP AT lt ASSIGNING FIELD-SYMBOL(<x>).\n  ENDLOOP.\nENDFORM.\n";
expect("a repeated field symbol is declared once per FORM", (cleanAbap(repeated).match(/FIELD-SYMBOL\(<x>\)/g) ?? []).length === 2 && cleanAbap(repeated).includes("ASSIGNING <x>."), cleanAbap(repeated));
const declared = "FORM a.\n  FIELD-SYMBOLS: <y> TYPE i.\n  READ TABLE lt ASSIGNING FIELD-SYMBOL(<y>) INDEX 1.\nENDFORM.\n";
expect("an explicit FIELD-SYMBOLS also counts", cleanAbap(declared).includes("ASSIGNING <y> INDEX 1."), cleanAbap(declared));
const counters = "  DATA lv_outer TYPE i VALUE 0.\n  LOOP AT lt INTO ls.\n    DATA lv_sum TYPE ekbe-wrbtr VALUE 0.\n    DATA lv_max TYPE i VALUE 5.\n    DATA lv_plain TYPE i.\n  ENDLOOP.\n";
const reset = cleanAbap(counters);
expect("a counter declared in a loop restarts each pass", reset.includes("VALUE 0.\n    CLEAR lv_sum.\n") && reset.includes("DATA lv_plain TYPE i.\n    CLEAR lv_plain.\n"), reset);
expect("outside a loop, or with a real start value, nothing is added", !reset.includes("CLEAR lv_outer") && !reset.includes("CLEAR lv_max"), reset);
const screenNames = "DATA: t_b1 TYPE string,\n      c_bukrs TYPE string,\n      lv_keep TYPE i.\nDATA c_werks TYPE string.\nSELECTION-SCREEN BEGIN OF BLOCK b1 WITH FRAME TITLE t_b1.\nSELECTION-SCREEN COMMENT 1(31) c_bukrs FOR FIELD s_bukrs.\nSELECTION-SCREEN COMMENT 1(31) c_werks FOR FIELD s_werks.\n";
const screenFixed = cleanAbap(screenNames);
expect("names the selection screen declares leave DATA, others stay", screenFixed.startsWith("DATA: lv_keep TYPE i.\nSELECTION-SCREEN BEGIN"), screenFixed);
const unassigned = runChecks({ ...prog, abap_source: "REPORT zmm_landed_cost.\nFIELD-SYMBOLS: <ls_out> TYPE i, <ls_ok> TYPE i, <ls_unused> TYPE i.\nLOOP AT lt ASSIGNING <ls_ok>.\n  <ls_ok> = 1.\nENDLOOP.\n<ls_out> = 1.\n" });
const neverSet = errorsOf(unassigned, "inline-decl").filter((i) => i.message.includes("never assigned"));
expect("a field symbol used but never assigned is flagged, others are not", neverSet.length === 1 && neverSet[0].message.startsWith("<ls_out>"), show(unassigned));
const product = "  lv_total = lv_price\n    * lv_quantity.\n";
expect("multiplication on a continuation line is left alone", cleanAbap(product) === product, cleanAbap(product));
expect("golden source unchanged by cleanAbap", cleanAbap(prog.abap_source) === prog.abap_source);

console.log("\n== inline-decl: bad declarations give one error each ==");
const inline = runChecks({
  ...prog,
  abap_source: [
    "REPORT zmm_landed_cost.",
    "DATA gt_out TYPE STANDARD TABLE OF i.",
    "DATA(lt_keys) = VALUE #( ( 1 ) ).",
    "LOOP AT lt_keys INTO DATA(lv_a).",
    "  APPEND lv_a TO lt_keys.",
    "ENDLOOP.",
    "CLEAR DATA(ls_out).",
    "DATA(lv_bucket) = ''.",
    "DATA(lv_text) = 'FREIGHT'.",
    "ls_out = 1.",
    "ls_out = 2.",
    "lv_missing = 1.",
    "lv_missing = 2.",
    "",
  ].join("\n"),
});
expect("VALUE # in DATA( ) flagged", has(inline, "inline-decl", "DATA(lt_keys) = VALUE #"), show(inline));
expect("CLEAR DATA( ) flagged", has(inline, "inline-decl", "CLEAR DATA(ls_out)"), show(inline));
expect("DATA( ) = '' flagged, a longer literal is not", errorsOf(inline, "inline-decl").filter((i) => i.message.includes("1-character")).length === 1 && has(inline, "inline-decl", "lv_bucket"), show(inline));
expect("no follow-up errors for those names", !errorsOf(inline, "abaplint").some((i) => /lt_keys|ls_out/.test(i.message)), show(inline));
const missing = errorsOf(inline, "abaplint").filter((i) => i.message.includes("lv_missing"));
expect("repeated not-found reported once with a count", missing.length === 1 && missing[0].message.includes("2 uses"), show(inline));

console.log("\n== select-target: wrong on a real system, invisible to abaplint ==");
const target = runChecks({
  ...prog,
  abap_source: [
    "REPORT zmm_landed_cost.",
    "DATA lt_ekko TYPE STANDARD TABLE OF ekko.",
    "DATA lt_werks TYPE SORTED TABLE OF ekpo-werks WITH UNIQUE KEY table_line.",
    "SELECT ebeln, bukrs FROM ekko WHERE ( @s_ebeln IS INITIAL OR ebeln IN @s_ebeln ) INTO TABLE @lt_ekko.",
    "SELECT ebeln, bukrs FROM ekko INTO CORRESPONDING FIELDS OF TABLE @lt_ekko.",
    "SELECT werks FROM ekpo INTO TABLE @lt_werks.",
    "SELECT ebeln, ebelp, vgabe, shkzg, dmbtr FROM ekbe INTO TABLE @lt_hist FOR ALL ENTRIES IN @lt_keys WHERE ebeln = @lt_keys[ sy-tabix ]-ebeln.",
    "SELECT ebeln FROM ekpo WHERE werks IN @lt_werks AND matnr IN @s_matnr AND ebeln IN @lr_ebeln INTO TABLE @lt_hist.",
    "DATA lt_cond TYPE STANDARD TABLE OF ekbz-kschl.",
    "IF lv_kschl IN lt_cond.",
    "ENDIF.",
    "lt_copy = VALUE #( FOR <x> IN lt_cond ( <x> ) ).",
    "PARAMETERS dummy1 TYPE c.",
    "",
  ].join("\n"),
});
const targets = errorsOf(target, "select-target");
expect("IN on a plain table flagged in ABAP, FOR x IN is not", targets.filter((i) => i.message.includes("field IN lt_cond")).length === 1, show(target));
expect("helper field on the selection screen flagged", has(target, "abapgit", "DUMMY1"), show(target));
expect("IN @ on a plain table flagged, select-options and ranges are not", targets.filter((i) => i.message.includes("needs a range table")).length === 2 && has(target, "select-target", "field IN @lt_werks"), show(target));
expect("table expression in FOR ALL ENTRIES flagged", targets.filter((i) => i.message.includes("@lt_keys[ ... ]")).length === 1, show(target));
expect("missing history key fields flagged", targets.filter((i) => i.message.includes("Missing: ZEKKN, GJAHR, BELNR, BUZEI")).length === 1, show(target));
expect("field list into a full-row table flagged", targets.filter((i) => i.message.includes("by position")).length === 1, show(target));
expect("select-option test in WHERE flagged", targets.filter((i) => i.message.includes("@s_ebeln IS INITIAL")).length === 1, show(target));

console.log("\n== FSD sections and merging ==");
const sampleFsd = [
  "# FSD - Vendor Aging (ZFI_AP_AGING)",
  "",
  "## 1. Document control",
  "",
  "| Program name | Status |",
  "|---|---|",
  "| ZFI_AP_AGING | Draft |",
  "",
  "## 2. Purpose",
  "",
  "Show open items.   Keep   this spacing exactly.",
  "",
  "## 3. Business rules",
  "",
  "| ID | Rule |",
  "|---|---|",
  "| FR-01 | Read open items. |",
  "| FR-02 | Bucket by days overdue. |",
  "",
  "## 4. Assumptions and constraints",
  "",
  "- A-1 Keep it simple.",
  "",
  "## 5. Open questions",
  "",
  "| ID | Question | Why it matters |",
  "|---|---|---|",
  "| Q-1 | Include blocked items? | Changes totals |",
  "",
].join("\n");
expect("parse and join round trip exactly", joinFsd(parseFsd(sampleFsd)) === sampleFsd);
expect("sections found", parseFsd(sampleFsd).sections.map((s) => s.title).join() === "Document control,Purpose,Business rules,Assumptions and constraints,Open questions");
expect("open questions read from the table", openQuestions(sampleFsd).join() === "Include blocked items?", openQuestions(sampleFsd).join());
const rulesChange = "## 3. Business rules\n\n| ID | Rule |\n|---|---|\n| FR-01 | Read open items. |\n| FR-02 | Bucket by days overdue, default 30. |\n| FR-03 | Exclude parked documents. |";
const merged = applySectionChanges(sampleFsd, [{ heading: "3. Business rules", action: "replace", markdown: rulesChange }]);
const sectionText = (md: string, key: string) => parseFsd(md).sections.find((s) => s.key === key)!.raw;
expect("untouched sections stay byte-identical", ["documentcontrol", "purpose", "assumptionsandconstraints", "openquestions"].every((k) => sectionText(merged, k).trimEnd() === sectionText(sampleFsd, k).trimEnd()), merged);
expect("the replaced section changed", merged.includes("FR-03"));
const added = applySectionChanges(sampleFsd, [{ heading: "Approval workflow", action: "add", markdown: "## Approval workflow\n\nA manager approves." }]);
expect("new section goes before assumptions and numbering follows", parseFsd(added).sections.map((s) => s.heading).join("|") === "1. Document control|2. Purpose|3. Business rules|4. Approval workflow|5. Assumptions and constraints|6. Open questions", parseFsd(added).sections.map((s) => s.heading).join("|"));
const removed = applySectionChanges(sampleFsd, [{ heading: "2. Purpose", action: "remove", markdown: "" }]);
expect("removed section is gone and numbering closes up", parseFsd(removed).sections.map((s) => s.heading).join("|") === "1. Document control|2. Business rules|3. Assumptions and constraints|4. Open questions");
expect("a heading without its number still matches", applySectionChanges(sampleFsd, [{ heading: "Purpose", action: "replace", markdown: "New purpose." }]).includes("## 2. Purpose\n\nNew purpose."));

const mixed2 = "# T\n\n## 1. A\n\nText.\n\n## Beta\n\nMore.\n\n## Gamma\n\nEnd.\n";
expect("unnumbered sections get numbers, text unchanged", renumberFsd(mixed2) === "# T\n\n## 1. A\n\nText.\n\n## 2. Beta\n\nMore.\n\n## 3. Gamma\n\nEnd.\n", renumberFsd(mixed2));

console.log("\n== FSD version numbers ==");
expect("first version", nextVersionLabel(undefined, "MINOR") === "1.0");
expect("minor", nextVersionLabel("1.0", "MINOR") === "1.1" && nextVersionLabel("1.9", "MINOR") === "1.10");
expect("major", nextVersionLabel("1.2", "MAJOR") === "2.0");
expect("minor after major", nextVersionLabel("2.0", "MINOR") === "2.1");

console.log("\n== FSD comparison ==");
const d = diffFsd(sampleFsd, merged);
expect("same text means no change", diffFsd(sampleFsd, sampleFsd).sections.every((s) => s.status === "unchanged"));
expect("added requirement", d.requirements.added.map((x) => x.id).join() === "FR-03", JSON.stringify(d.requirements));
expect("modified requirement", d.requirements.modified.map((x) => x.id).join() === "FR-02");
expect("nothing reported removed", d.requirements.removed.length === 0);
expect("only the rules section is marked changed", changedSections(sampleFsd, merged).map((s) => s.title).join() === "Business rules");
expect("rules are tagged as business rules", d.sections.find((s) => s.status === "modified")?.area === "Business rules");
const dropped = diffFsd(merged, sampleFsd);
expect("removed requirement detected going the other way", dropped.requirements.removed.map((x) => x.id).join() === "FR-03");
expect("removed and added sections detected", changedSections(sampleFsd, added).some((s) => s.status === "added") && changedSections(added, sampleFsd).some((s) => s.status === "removed"));

async function docxTests() {
console.log("\n== DOCX ==");
const fsdVersion = (label: string, status: string, markdown: string, version: number): FsdVersion => ({
  id: version, requirement_id: 9, version, markdown, sha256: "a".repeat(64), status, source: "AGENT", author: "x", created_at: "2026-11-03T10:00:00.000Z",
  label, parent_id: null, change_type: "MINOR", change_summary: `Summary of ${label}`, sections_changed_json: null,
  doc_type: "FS", wricef: "R", fs_version_id: null,
});
const richFsd = `${sampleFsd}\n## 6. Details\n\nText with **bold**, *italic*, \`code\` and A & B < C.\n\n1. First\n2. Second\n   - Nested\n\n- Bullet\n\n1. Restarted\n\n### Sub heading\n\n\`\`\`\nline one\n\`\`\`\n`;
const v1 = fsdVersion("1.0", "SUPERSEDED", sampleFsd, 1);
const v2 = fsdVersion("1.1", "APPROVED", richFsd, 2);
const pngLogo = Uint8Array.from(fs.readFileSync("fixtures/sample-client-logo.png"));
const jpgLogo = Uint8Array.from(fs.readFileSync("templates/logo-supernova.jpg"));
expect("logo size read from a PNG", JSON.stringify(imageSize(pngLogo, "image/png")) === '{"width":287,"height":111}', JSON.stringify(imageSize(pngLogo, "image/png")));
const fitted = fitInto(imageSize(pngLogo, "image/png"), { width: 1485900, height: 573405 });
expect("logo size read from a JPG", (imageSize(jpgLogo, "image/jpeg")?.width ?? 0) > 0, JSON.stringify(imageSize(jpgLogo, "image/jpeg")));
expect("logo is scaled to fit and keeps its shape", JSON.stringify(fitInto({ width: 300, height: 82 }, { width: 1485900, height: 573405 })) === '{"width":1485900,"height":406146}');
const acme = { name: "Acme Industries Ltd", logo: pngLogo, logoType: "image/png" };
const buffer = await buildFsdDocx({ version: v2, history: [v1, v2], requirementId: 9, requirementTitle: "Vendor Aging", client: acme, approval: { approver: "Functional Approver", decided_at: "2026-11-03T11:00:00.000Z" } });
const zip = await JSZip.loadAsync(buffer);
const documentXml = await zip.file("word/document.xml")!.async("string");
const plain = documentXml.replace(/<[^>]+>/g, "");
const footer = (await zip.file("word/footer1.xml")!.async("string")).replace(/<[^>]+>/g, "");
expect("a real .docx built on the company template", buffer.subarray(0, 2).toString() === "PK" && !!zip.file("word/styles.xml") && !!zip.file("word/header1.xml"));
const headerRels = await Promise.all(["word/_rels/header1.xml.rels", "word/_rels/header2.xml.rels"].map((f) => zip.file(f)!.async("string")));
const headers = await Promise.all(["word/header1.xml", "word/header2.xml"].map((f) => zip.file(f)!.async("string")));
expect("SuperNova logo is always there", !!zip.file("word/media/image3.jpg") && headerRels.every((r) => r.includes("media/image3.jpg")));
expect("the client's logo replaces the reference logo", !zip.file("word/media/image2.png") && !!zip.file("word/media/client-logo.png") && headerRels.every((r) => r.includes("media/client-logo.png") && !r.includes("image2.png")));
expect("client logo keeps its shape", Math.abs(fitted.width / fitted.height - 287 / 111) < 0.01 && headers.every((h) => h.includes(`cx="${fitted.width}" cy="${fitted.height}"`)), JSON.stringify(fitted));
expect("cover and properties name the client", plain.includes("Company NameAcme Industries Ltd") && (await zip.file("docProps/app.xml")!.async("string")).includes("<Company>Acme Industries Ltd</Company>"));
const noClient = await JSZip.loadAsync(await buildFsdDocx({ version: v2, history: [v1, v2], requirementId: 9, requirementTitle: "Vendor Aging" }));
const bareHeaders = await Promise.all(["word/header1.xml", "word/header2.xml"].map((f) => noClient.file(f)!.async("string")));
const bareRels = await Promise.all(["word/_rels/header1.xml.rels", "word/_rels/header2.xml.rels"].map((f) => noClient.file(f)!.async("string")));
const bareText = (await noClient.file("word/document.xml")!.async("string")).replace(/<[^>]+>/g, "");
expect("without a client, no reference logo and no company name", !noClient.file("word/media/image2.png") && bareRels.every((r) => !r.includes("image2.png")) && bareHeaders.every((h) => (h.match(/<w:drawing>/g) ?? []).length === 1) && bareText.includes("Company NameProject"), bareText.slice(0, 200));
const appXml = await zip.file("docProps/app.xml")!.async("string");
expect("people, screenshot and old company name from the reference are gone", !zip.file("word/media/image1.png") && !/Arbaz|Jhanzeb|Fasih|Khalid|Manoj|Siemens/.test(plain + footer + appXml));
expect("skeleton matches the reference", ["Functional Specification Document", "Table of Contents", "Requirement detail", "Description of Business Requirement (Purpose and Use)", "Related Transactions", "Functional specifications", "Finalization", "Sign-off"].every((t) => plain.includes(t)), plain.slice(0, 400));
expect("cover has all 12 labels", ["Company Name", "Module", "ABAP-ID", "Requirement Title", "WRICEF Type", "Priority", "Priority Type", "Deadline", "Functional Consultant Name", "Technical Consultant Name", "Date of Preparation", "Approval Date"].every((t) => plain.includes(t)));
expect("cover carries the program and approval date", plain.includes("ABAP-IDZFI_AP_AGING") && plain.includes("Approval Date11/03/2026"), plain.slice(0, 700));
expect("sections use the template numbering and styles", documentXml.includes('<w:numId w:val="33"/>') && documentXml.includes('w:val="Heading1"') && documentXml.includes('w:val="TOC1"'));
expect("tables use the template colours", documentXml.includes('w:color="3399FF"') && documentXml.includes('w:fill="DEEAF6"'));
expect("every FSD section is kept", ["Business rules", "Assumptions and constraints", "Open questions", "Details"].every((t) => plain.includes(t)) && plain.includes("FR-02") && plain.includes("Include blocked items?"));
expect("numbered lists restart, bullets use the template list", new Set([...documentXml.matchAll(/<w:numId w:val="(91\d\d)"/g)].map((m) => m[1])).size >= 2 && documentXml.includes('<w:numId w:val="34"/>'));
expect("special characters survive", plain.includes("A &amp; B &lt; C"), plain.slice(-300));
expect("footer shows version and dates, no placeholder left", footer.includes("Ver 1.1") && footer.includes("11/03/2026") && !footer.includes("{{"), footer);
const draft = await JSZip.loadAsync(await buildFsdDocx({ version: fsdVersion("1.2", "DRAFT", sampleFsd, 3), history: [v1], requirementId: 9, requirementTitle: "Vendor Aging" }));
const draftFooter = (await draft.file("word/footer1.xml")!.async("string")).replace(/<[^>]+>/g, "");
expect("a draft says so on every page", draftFooter.includes("Ver 1.2 Draft"), draftFooter);
const outputFsd = "# FSD - T (ZT)\n\n## 1. Output columns\n\n| # | Column | Heading | Source / formula | Currency/unit reference | Totals |\n|---|---|---|---|---|---|\n| 1 | LIFNR | Vendor | EKKO-LIFNR | - | None |\n| 2 | AMT | Amount | Sum of EKBE-WRBTR (FR-01) | EKKO-WAERS | Total |\n\nSorted by vendor.\n";
const fieldZip = await JSZip.loadAsync(await buildFsdDocx({ version: fsdVersion("1.0", "APPROVED", outputFsd, 1), history: [], requirementId: 9, requirementTitle: "T" }));
const fieldText = (await fieldZip.file("word/document.xml")!.async("string")).replace(/<[^>]+>/g, "");
expect("output columns become the company field table, nothing lost", ["Solution Design", "Technical Name", "Logic Description", "VendorLIFNREKKOEKKO-LIFNR", "Unit: EKKO-WAERS", "Totals: Total", "Sorted by vendor."].every((t) => fieldText.includes(t)), fieldText.slice(-500));
expect("cover shows WRICEF, requirement ID, version and a revision history", ["WRICEF TypeReport (R)", "Requirement IDREQ-9", "Document Version1.1 (Approved)", "Revision history", "Summary of 1.0"].every((t) => plain.includes(t)), plain.slice(0, 900));

console.log("\n== WRICEF ==");
expect("only Report and Workflow choices start anything", CHOICES.filter((c) => c.supported).every((c) => c.wricef || c.linked) && CHOICES.filter((c) => !c.supported).every((c) => !c.wricef && !!c.message));
expect("I, C, E and F are unsupported", ["interface", "conversion", "enhancement", "form"].every((id) => CHOICES.find((c) => c.id === id)?.supported === false));
expect("a background job is a report run in the background", CHOICES.find((c) => c.id === "job")?.wricef === "R" && CHOICES.find((c) => c.id === "job")?.execution === "BACKGROUND");
expect("signs of another type are spotted, a plain report is not", otherTypeSigns("Send the PO by IDoc and print an Adobe form").join() === "an Interface,a Form" && otherTypeSigns("Open vendor items by aging bucket").length === 0);

console.log("\n== Workflow process flow diagram ==");
const flowFs = [
  "# FSD - PO approval (ZWF_PO_APPROVAL)",
  "",
  "## 1. Document control",
  "",
  "| Workflow name | Module | Object type |",
  "|---|---|---|",
  "| ZWF_PO_APPROVAL | MM | Workflow |",
  "",
  "## 2. Business background and objectives",
  "",
  "Purchase orders above a limit need approval.",
  "",
  "## 3. Process flow",
  "",
  "| Step | Type | Actor | Description | Next |",
  "|---|---|---|---|---|",
  "| 1 | Start | Buyer | PO is saved | 2 |",
  "| 2 | Decision | System | Is the net value above 10,000? | Yes: 3; No: 5 |",
  "| 3 | Approval | Purchasing manager | Approve or reject the purchase order | Approved: 5; Rejected: 4; Returned: 1 |",
  "| 4 | Notification | System | Tell the buyer the PO was rejected | 6 |",
  "| 5 | System | System | Release the purchase order | 6 |",
  "| 6 | End | - | Workflow complete | |",
  "",
  "## 4. Approval matrix",
  "",
  "| Level | Condition | Approver | Mode | Deadline |",
  "|---|---|---|---|---|",
  "| 1 | Net value > 10,000 | Purchasing manager | Sequential | 2 days |",
  "",
].join("\n");
const steps = parseFlow(marked.lexer(parseFsd(flowFs).sections.find((x) => x.key === "processflow")!.body));
expect("process flow table is read", steps.length === 6 && steps[1].next.map((n) => `${n.label}:${n.to}`).join() === "Yes:3,No:5" && steps[2].next.length === 3, JSON.stringify(steps[1]));
const drawn = drawFlow(steps)!;
const wanted = ["Start: PO is saved", "3. Purchasing manager", "Rejected", "Returned", "stroke-dasharray", "End: Workflow complete"];
expect("diagram has every step, branch label and a loop back", wanted.every((t) => drawn.svg.includes(t)) && drawn.warnings.length === 0, `missing: ${wanted.filter((t) => !drawn.svg.includes(t)).join(", ")} ${drawn.warnings.join()}`);
expect("a step pointing nowhere is reported, not drawn", drawFlow([{ step: 1, type: "Start", actor: "", description: "", next: [{ label: "", to: 9 }] }, { step: 2, type: "End", actor: "", description: "", next: [] }])!.warnings.some((w) => w.includes("step 9")));
const png = await flowPng(drawn);
expect("diagram renders to PNG", png.subarray(1, 4).toString() === "PNG" && png.length > 5000);
if (process.argv[2]) fs.writeFileSync(process.argv[2].replace(/\.docx$/, "-flow.png"), png);
const wfFs: FsdVersion = { ...fsdVersion("1.0", "DRAFT", flowFs, 1), wricef: "W" };
const wfZip = await JSZip.loadAsync(await buildFsdDocx({ version: wfFs, history: [wfFs], requirementId: 12, requirementTitle: "PO approval" }));
const wfXml = await wfZip.file("word/document.xml")!.async("string");
const wfText = wfXml.replace(/<[^>]+>/g, "");
const wfRels = await wfZip.file("word/_rels/document.xml.rels")!.async("string");
expect("workflow FS: workflow cover, diagram embedded in the document", wfText.includes("WRICEF TypeWorkflow (W)") && wfText.includes("Workflow IDZWF_PO_APPROVAL") && wfXml.includes('r:embed="rIdFlow1"') && wfRels.includes("media/flow-1.png") && !!wfZip.file("word/media/flow-1.png"));
expect("workflow FS has no report field table", !wfText.includes("Solution Design"));
const tsVersion: FsdVersion = { ...fsdVersion("1.0", "DRAFT", "# TS - PO approval (ZWF_PO_APPROVAL)\n\n## 1. Document control\n\n| Workflow name | Technology |\n|---|---|\n| ZWF_PO_APPROVAL | Classic |\n\n## 2. Technical overview\n\nDesign only.\n\n## 3. Technical implementation plan\n\n1. Create the task.\n", 1), doc_type: "TS", wricef: "W" };
const tsZip = await JSZip.loadAsync(await buildFsdDocx({ version: tsVersion, history: [tsVersion], requirementId: 12, requirementTitle: "PO approval", fsLabel: "1.2" }));
const tsText = (await tsZip.file("word/document.xml")!.async("string")).replace(/<[^>]+>/g, "");
const tsFooter = (await tsZip.file("word/footer1.xml")!.async("string")).replace(/<[^>]+>/g, "");
expect("TS is its own document: title, overview box, based-on FS, footer", tsText.includes("Technical Specification Document") && tsText.includes("Technical Overview") && tsText.includes("Based on FS Version1.2") && tsText.includes("Technical specifications") && tsFooter.includes("Technical Specification"), tsText.slice(0, 600));
const wfPdf = await buildFsdPdf({ version: wfFs, history: [wfFs], requirementId: 12, requirementTitle: "PO approval" });
expect("workflow PDF builds with the diagram", wfPdf.subarray(0, 5).toString() === "%PDF-" && wfPdf.length > 40000, String(wfPdf.length));
if (process.argv[2]) fs.writeFileSync(process.argv[2].replace(/\.docx$/, "-workflow.pdf"), wfPdf);

console.log("\n== PDF ==");
const pdf = await buildFsdPdf({ version: v2, history: [v1, v2], requirementId: 9, requirementTitle: "Vendor Aging", client: acme, approval: { approver: "Functional Approver", decided_at: "2026-11-03T11:00:00.000Z" } });
expect("a real PDF file", pdf.subarray(0, 5).toString() === "%PDF-" && pdf.subarray(-6).toString().includes("%%EOF"));
const draftPdf = await buildFsdPdf({ version: fsdVersion("1.2", "DRAFT", sampleFsd, 3), history: [v1], requirementId: 9, requirementTitle: "Vendor Aging" });
expect("builds for a draft without a client too", draftPdf.subarray(0, 5).toString() === "%PDF-");
const jpgPdf = await buildFsdPdf({ version: v2, history: [v1, v2], requirementId: 9, requirementTitle: "Vendor Aging", client: { name: "Jpeg Co", logo: jpgLogo, logoType: "image/jpeg" } });
expect("builds with a JPG client logo", jpgPdf.subarray(0, 5).toString() === "%PDF-" && jpgPdf.length > pdf.length - 20000);
if (process.argv[2]) {
  fs.writeFileSync(process.argv[2], buffer);
  fs.writeFileSync(process.argv[2].replace(/docx$/, "pdf"), pdf);
}
}

console.log("\n== Checks on a corrected variant (auth check + ME33L branch) ==");
const fixed: GeneratedProgram = {
  ...prog,
  abap_source: prog.abap_source
    .replace("bukrs     TYPE ekko-bukrs,    \" Company Code", "bukrs     TYPE ekko-bukrs,    \" Company Code\n         bstyp     TYPE ekko-bstyp,    \" Document Category")
    .replace("SELECT k~bukrs, p~werks,", "SELECT k~bukrs, k~bstyp, p~werks,")
    .replace(
      "  IF gt_out IS INITIAL.\n    RETURN.\n  ENDIF.\n\n* Material value",
      "  IF gt_out IS INITIAL.\n    RETURN.\n  ENDIF.\n\n  LOOP AT gt_out INTO DATA(ls_auth).\n    AUTHORITY-CHECK OBJECT 'M_BEST_WRK'\n      ID 'ACTVT' FIELD '03'\n      ID 'WERKS' FIELD ls_auth-werks.\n    IF sy-subrc <> 0.\n      DELETE gt_out.\n    ENDIF.\n  ENDLOOP.\n\n* Material value",
    )
    .replace(
      "        SET PARAMETER ID 'BES' FIELD ls_out-ebeln.\n        CALL TRANSACTION 'ME23N' WITH AUTHORITY-CHECK.",
      "        IF ls_out-bstyp = 'L'.\n          SET PARAMETER ID 'VRT' FIELD ls_out-ebeln.\n          CALL TRANSACTION 'ME33L' WITH AUTHORITY-CHECK.\n        ELSE.\n          SET PARAMETER ID 'BES' FIELD ls_out-ebeln.\n          CALL TRANSACTION 'ME23N' WITH AUTHORITY-CHECK.\n        ENDIF.",
    ),
};
const f = runChecks(fixed);
console.log(`      ${show(f) || "(no issues)"}`);
expect("corrected variant has 0 errors", f.errors === 0, show(f));

docxTests().then(() => {
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll self-tests passed.");
  process.exit(failed ? 1 : 0);
});
