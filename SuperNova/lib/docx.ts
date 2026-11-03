// Builds the FSD as a real Word document from templates/fsd-template.docx, the company's own FSD.
// Styles, numbering, theme, header logos and the footer table all come from that file unchanged;
// only the body and the footer values are written here, using the same paragraph and table formats.
import fs from "node:fs";
import JSZip from "jszip";
import type { Token, Tokens } from "marked";
import { buildFsdLayout, columnShares, decodeEntities as decode, templateFile, type FsdDocumentInput, type FsdLayout, type LayoutSection } from "./fsd-document";
import { fitInto, imageSize } from "./client";
import { drawFlow, flowPng } from "./flow-diagram";

const TABLE_WIDTH = 9187; // the field table in the template
const LIST_ABSTRACT = 9001;
const LIST_FIRST_NUM = 9100;
const BULLET_NUM = 34; // the template's bullet list
const HEADING_NUM = 33; // the template's "1." numbering for specification headings

const THEME_FONTS = '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:cstheme="minorHAnsi"/>';
const CALIBRI = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>';
const SIZE_22 = '<w:sz w:val="22"/><w:szCs w:val="22"/>';
const BORDER = (color: string, size = 4) => ["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="${size}" w:space="0" w:color="${color}"/>`).join("");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const text = (s: string) => `<w:t xml:space="preserve">${esc(s)}</w:t>`;

type RunStyle = { fonts?: string; bold?: boolean; italics?: boolean; strike?: boolean; mono?: boolean; color?: string; size?: string; link?: boolean };

/** Children in the order the schema requires. */
function rPr(s: RunStyle) {
  const parts = [
    s.link ? '<w:rStyle w:val="Hyperlink"/>' : "",
    s.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : (s.fonts ?? ""),
    s.bold ? "<w:b/><w:bCs/>" : "",
    s.italics ? "<w:i/><w:iCs/>" : "",
    s.strike ? "<w:strike/>" : "",
    s.color ? `<w:color w:val="${s.color}"/>` : "",
    s.size ?? "",
  ].join("");
  return parts ? `<w:rPr>${parts}</w:rPr>` : "";
}

const run = (s: string, style: RunStyle = {}) => `<w:r>${rPr(style)}${text(s)}</w:r>`;

class Writer {
  links: string[] = [];
  lists = 0;

  runs(tokens: Token[] | undefined, s: RunStyle = {}): string {
    return (tokens ?? []).map((t): string => {
      switch (t.type) {
        case "strong":
          return this.runs((t as Tokens.Strong).tokens, { ...s, bold: true });
        case "em":
          return this.runs((t as Tokens.Em).tokens, { ...s, italics: true });
        case "del":
          return this.runs((t as Tokens.Del).tokens, { ...s, strike: true });
        case "codespan":
          return run(decode((t as Tokens.Codespan).text), { ...s, mono: true });
        case "br":
          return `<w:r>${rPr(s)}<w:br/></w:r>`;
        case "link": {
          const link = t as Tokens.Link;
          if (!/^https?:/i.test(link.href)) return this.runs(link.tokens, s);
          this.links.push(link.href);
          return `<w:hyperlink r:id="rIdLink${this.links.length}" w:history="1">${this.runs(link.tokens, { ...s, link: true })}</w:hyperlink>`;
        }
        default: {
          const inner = t as Tokens.Text;
          return inner.tokens?.length ? this.runs(inner.tokens, s) : run(decode(inner.text ?? t.raw ?? ""), s);
        }
      }
    }).join("");
  }

  /** The template's field table: blue rules, light blue header row. */
  table(rows: { xml: string; plain: string }[][]) {
    const wide = rows[0].length > 4;
    const size = wide ? '<w:sz w:val="20"/><w:szCs w:val="20"/>' : SIZE_22;
    const shares = columnShares(rows.map((r) => r.map((c) => c.plain)), wide ? 5.5 : 6);
    const widths = shares.map((share) => Math.floor(share * TABLE_WIDTH));
    widths[widths.length - 1] += TABLE_WIDTH - widths.reduce((a, b) => a + b, 0);
    const cell = (c: { xml: string }, i: number, header: boolean) => {
      const shade = header ? '<w:shd w:val="clear" w:color="auto" w:fill="DEEAF6" w:themeFill="accent5" w:themeFillTint="33"/>' : "";
      const centered = i > 0 && rows[0].length <= 4 ? '<w:jc w:val="center"/>' : "";
      return `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/>${shade}</w:tcPr><w:p><w:pPr><w:pStyle w:val="Texto"/>${centered}</w:pPr>${c.xml.replace(/%SIZE%/g, size)}</w:p></w:tc>`;
    };
    const trs = rows.map((row, r) => {
      const props = r === 0 ? '<w:trPr><w:cantSplit/><w:trHeight w:val="640"/><w:tblHeader/></w:trPr>' : "<w:trPr><w:cantSplit/></w:trPr>";
      return `<w:tr>${props}${row.map((c, i) => cell(c, i, r === 0)).join("")}</w:tr>`;
    });
    return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${TABLE_WIDTH}" w:type="dxa"/><w:tblInd w:w="108" w:type="dxa"/><w:tblBorders>${BORDER("3399FF", 6)}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLook w:val="01E0" w:firstRow="1" w:lastRow="1" w:firstColumn="1" w:lastColumn="1" w:noHBand="0" w:noVBand="0"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${trs.join("")}</w:tbl>`;
  }

  /** Marks where the cell's font size goes: it depends on how many columns the table turns out to have. */
  cell(tokens: Token[] | undefined, plain: string, bold = false) {
    return { plain, xml: this.runs(tokens, { fonts: THEME_FONTS, bold, size: "%SIZE%" }) };
  }

  plainCell(s: string, bold = false) {
    return { plain: s, xml: run(s, { fonts: THEME_FONTS, bold, size: "%SIZE%" }) };
  }

  list(list: Tokens.List, level = 0, numId = 0): string {
    const id = list.ordered ? numId || LIST_FIRST_NUM + this.lists++ : BULLET_NUM;
    return list.items.map((item) => {
      const own = item.tokens.filter((t) => t.type !== "list");
      const nested = item.tokens.filter((t) => t.type === "list") as Tokens.List[];
      const runs = own.map((t) => this.runs((t as Tokens.Text).tokens ?? [t], { fonts: THEME_FONTS, size: SIZE_22 })).join("");
      const paragraph = `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${id}"/></w:numPr></w:pPr>${runs}</w:p>`;
      return paragraph + nested.map((n) => this.list(n, Math.min(level + 1, 1), n.ordered ? id : 0)).join("");
    }).join("");
  }

  blocks(tokens: Token[]): string {
    return tokens.map((t): string => {
      switch (t.type) {
        case "heading":
          return `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${this.runs((t as Tokens.Heading).tokens, { fonts: THEME_FONTS, bold: true, color: "000000" })}</w:p>`;
        case "paragraph":
          return `<w:p>${this.runs((t as Tokens.Paragraph).tokens)}</w:p>`;
        case "list":
          return this.list(t as Tokens.List) + "<w:p/>";
        case "table": {
          const tb = t as Tokens.Table;
          const head = tb.header.map((c) => this.cell(c.tokens, decode(c.text), true));
          const rows = tb.rows.map((r) => r.map((c) => this.cell(c.tokens, decode(c.text))));
          return this.table([head, ...rows]) + "<w:p/>";
        }
        case "code":
          return (t as Tokens.Code).text.split("\n").map((l) => `<w:p>${run(l, { mono: true })}</w:p>`).join("");
        case "blockquote":
          return this.blocks((t as Tokens.Blockquote).tokens);
        default:
          return "";
      }
    }).join("");
  }
}

// ---------------------------------------------------------------- fixed parts
function coverRow([label, value]: [string, string], index: number, last: number) {
  const edges = index === 0 || index === last ? "top bottom" : "bottom";
  const sides = edges.split(" ").map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join("");
  const labelBorders = ["top", "left", "bottom", "right"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join("");
  const labelRun = { fonts: CALIBRI, bold: true, color: "000000", size: SIZE_22 };
  const valueRun = { fonts: CALIBRI, color: "000000", size: SIZE_22 };
  return `<w:tr><w:tc><w:tcPr><w:tcW w:w="3380" w:type="dxa"/><w:tcBorders>${labelBorders}</w:tcBorders><w:shd w:val="clear" w:color="auto" w:fill="DEEAF6"/></w:tcPr><w:p>${label ? run(label, labelRun) : ""}</w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="5970" w:type="dxa"/><w:tcBorders>${sides}</w:tcBorders><w:shd w:val="clear" w:color="auto" w:fill="auto"/></w:tcPr><w:p>${value ? run(value, valueRun) : ""}</w:p></w:tc></w:tr>`;
}

function cover(layout: FsdLayout) {
  const heading = layout.heading;
  const bigBlank = '<w:p><w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light" w:cs="Calibri Light"/><w:b/><w:bCs/><w:color w:val="2F5496"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:pPr></w:p>';
  const blank = '<w:p><w:pPr><w:rPr><w:rFonts w:cs="Arial"/><w:color w:val="000000"/></w:rPr></w:pPr></w:p>';
  const title = '<w:p><w:pPr><w:pStyle w:val="Title"/><w:jc w:val="center"/><w:rPr><w:b/><w:bCs/><w:color w:val="2F5496" w:themeColor="accent1" w:themeShade="BF"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:bCs/><w:color w:val="2F5496" w:themeColor="accent1" w:themeShade="BF"/></w:rPr><w:t>__HEADING__</w:t></w:r></w:p>'.replace("__HEADING__", heading);
  const borders = ["top", "left", "bottom", "right"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join("");
  const table = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="0"/></w:tblPr><w:tblGrid><w:gridCol w:w="3380"/><w:gridCol w:w="5970"/></w:tblGrid>${layout.cover.map((r, i) => coverRow(r, i, layout.cover.length - 1)).join("")}</w:tbl>`;
  return bigBlank.repeat(3) + title + blank.repeat(10) + table;
}

type TocEntry = { label: string; number?: number; bookmark: string; page: number; level: 1 | 2 };

function tocLine(e: TocEntry, first: boolean) {
  const hidden = "<w:rPr><w:noProof/><w:webHidden/></w:rPr>";
  const tabs = e.number ? '<w:tab w:val="left" w:pos="400"/><w:tab w:val="right" w:leader="dot" w:pos="9350"/>' : '<w:tab w:val="right" w:leader="dot" w:pos="9350"/>';
  const pPr = `<w:pPr><w:pStyle w:val="TOC${e.level}"/><w:tabs>${tabs}</w:tabs><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/><w:noProof/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:pPr>`;
  const link = '<w:rPr><w:rStyle w:val="Hyperlink"/><w:noProof/></w:rPr>';
  // dirty asks Word to work out the real page numbers when the file opens; the numbers here are estimates until then.
  const field = first ? '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' : "";
  const number = e.number ? `<w:r>${link}<w:t>${e.number}.</w:t></w:r><w:r><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/><w:noProof/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:tab/></w:r>` : "";
  return `<w:p>${pPr}${field}<w:hyperlink w:anchor="${e.bookmark}" w:history="1">${number}<w:r>${link}${text(e.label)}</w:r><w:r>${hidden}<w:tab/></w:r><w:r>${hidden}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${hidden}<w:instrText xml:space="preserve"> PAGEREF ${e.bookmark} \\h </w:instrText></w:r><w:r>${hidden}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${hidden}<w:t>${e.page}</w:t></w:r><w:r>${hidden}<w:fldChar w:fldCharType="end"/></w:r></w:hyperlink></w:p>`;
}

function toc(entries: TocEntry[]) {
  const heading = '<w:p><w:pPr><w:pStyle w:val="TOCHeading"/><w:pageBreakBefore/><w:jc w:val="center"/><w:rPr><w:b/><w:bCs/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:bCs/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr><w:t>Table of Contents</w:t></w:r></w:p>';
  const end = '<w:p><w:r><w:rPr><w:b/><w:bCs/><w:noProof/></w:rPr><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  return `<w:sdt><w:sdtPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="auto"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:id w:val="-2101468911"/><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtEndPr><w:rPr><w:b/><w:bCs/><w:noProof/></w:rPr></w:sdtEndPr><w:sdtContent>${heading}${entries.map((e, i) => tocLine(e, i === 0)).join("")}${end}</w:sdtContent></w:sdt>`;
}

function headerCell(title: string[]) {
  const runs = title.map((t, i) => run(t, { fonts: CALIBRI, ...(i > 0 ? { color: "000000" } : { color: "000000" }), size: SIZE_22 }).replace("<w:rPr>", i > 0 ? '<w:rPr>' : "<w:rPr>")).join("");
  return `<w:tr><w:trPr><w:trHeight w:val="382"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="9591" w:type="dxa"/><w:tcBorders><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tcBorders><w:shd w:val="clear" w:color="auto" w:fill="DEEAF6"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="Heading8"/><w:ind w:left="0"/></w:pPr>${runs}</w:p></w:tc></w:tr>`;
}

const boxTable = (rows: string) =>
  `<w:tbl><w:tblPr><w:tblW w:w="9591" w:type="dxa"/><w:tblBorders>${BORDER("auto")}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="0"/></w:tblPr><w:tblGrid><w:gridCol w:w="9591"/></w:tblGrid>${rows}</w:tbl>`;

const bookmark = (id: number, name: string, inner: string) => `<w:bookmarkStart w:id="${id}" w:name="${name}"/>${inner}<w:bookmarkEnd w:id="${id}"/>`;

/** The revision history of this document, as the template's field table. */
function revisionHistory(layout: FsdLayout, w: Writer, mark: string) {
  const heading = `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:pageBreakBefore/></w:pPr>${bookmark(3, mark, "<w:r><w:t>Revision history</w:t></w:r>")}</w:p>`;
  const rows = [["Version", "Date", "Status", "Description of change"], ...layout.revisions].map((r, i) => r.map((c) => w.plainCell(c, i === 0)));
  return heading + "<w:p/>" + w.table(rows) + "<w:p/>";
}

function requirementDetail(layout: FsdLayout, w: Writer, mark: string) {
  const heading = `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:pageBreakBefore/><w:rPr><w:lang w:val="en-US"/></w:rPr></w:pPr>${bookmark(1, mark, "<w:r><w:rPr><w:lang w:val=\"en-US\"/></w:rPr><w:t>Requirement detail</w:t></w:r>")}</w:p>`;

  const paragraph = (runs: string) => `<w:p><w:pPr><w:pStyle w:val="09TableContent1"/></w:pPr>${runs}</w:p>`;
  const purpose = layout.purpose.filter((t) => t.type !== "space").map((t) => {
    const inner = (t as Tokens.Paragraph).tokens ?? [t];
    return paragraph(w.runs(inner, { fonts: THEME_FONTS, color: "000000", size: '<w:sz w:val="22"/>' }));
  }).join(paragraph(""));
  const description = boxTable(
    headerCell([layout.technical ? "Technical Overview" : "Description of Business Requirement (Purpose and Use)"]) +
    `<w:tr><w:trPr><w:trHeight w:val="1790"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="9591" w:type="dxa"/><w:tcBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tcBorders></w:tcPr>${purpose || paragraph("")}</w:tc></w:tr>`,
  );

  const code = '<w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsia="Times New Roman" w:hAnsiTheme="minorHAnsi" w:cstheme="minorHAnsi"/><w:color w:val="000000"/></w:rPr>';
  const lines = (layout.transactions.length ? layout.transactions : ["None"]).map((t) => `<w:p><w:pPr><w:pStyle w:val="p1"/></w:pPr><w:r>${code}${text(t)}</w:r></w:p>`).join("");
  const transactions = boxTable(headerCell(["Related Transactions"]) + `<w:tr><w:trPr><w:trHeight w:val="1569"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="9591" w:type="dxa"/></w:tcPr>${lines}</w:tc></w:tr>`);

  const gap = '<w:p><w:pPr><w:pStyle w:val="Heading8"/><w:ind w:left="0"/></w:pPr></w:p>';
  return heading + "<w:p/>" + description + gap + transactions + "<w:p/>";
}

/** A picture as its own centred paragraph; Word needs the namespaces on the elements themselves here. */
function picture(rId: string, id: number, width: number, height: number, name: string) {
  const MAX_W = 5943600; // 6.5 inches, the text width
  const MAX_H = 7772400; // 8.5 inches
  const scale = Math.min(MAX_W / width, MAX_H / height);
  const cx = Math.round(width * scale);
  const cy = Math.round(height * scale);
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="${esc(name)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(name)}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function section(s: LayoutSection & { diagram?: { rId: string; width: number; height: number } }, w: Writer, mark: string, id: number) {
  const fonts = '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:cstheme="minorHAnsi"/><w:sz w:val="28"/><w:lang w:val="en-GB"/>';
  const heading = `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${HEADING_NUM}"/></w:numPr><w:spacing w:before="360" w:after="120"/><w:rPr>${fonts}</w:rPr></w:pPr>${bookmark(id, mark, `<w:r><w:rPr>${fonts}</w:rPr>${text(s.title)}</w:r>`)}</w:p>`;
  const intro = s.intro
    ? `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${BULLET_NUM}"/></w:numPr><w:tabs><w:tab w:val="left" w:pos="284"/><w:tab w:val="left" w:pos="567"/><w:tab w:val="left" w:pos="851"/></w:tabs></w:pPr>${run(s.intro, { fonts: THEME_FONTS, color: "FF0000", size: SIZE_22 })}</w:p><w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="0"/><w:jc w:val="both"/></w:pPr></w:p>`
    : "";
  const fields = s.fields ? w.table(s.fields.map((r, i) => r.map((c) => w.plainCell(c, i === 0)))) + "<w:p/>" : "";
  const caption = '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' + run("Process flow diagram, drawn from the table above", { fonts: THEME_FONTS, italics: true, color: "595959", size: '<w:sz w:val="18"/><w:szCs w:val="18"/>' }) + "</w:p>";
  const diagram = s.diagram ? picture(s.diagram.rId, 600 + id, s.diagram.width, s.diagram.height, "Process flow") + caption : "";
  return heading + intro + fields + w.blocks(s.tokens) + diagram;
}

function signOff(layout: FsdLayout, finalMark: string, signMark: string) {
  const fonts = THEME_FONTS;
  const h1 = `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:rPr>${fonts}<w:szCs w:val="36"/><w:lang w:val="en-US"/></w:rPr></w:pPr>${bookmark(990, finalMark, `<w:r><w:rPr>${fonts}<w:szCs w:val="36"/><w:lang w:val="en-US"/></w:rPr><w:t>Finalization</w:t></w:r>`)}</w:p>`;
  const h2Props = `${fonts}<w:b/><w:bCs w:val="0"/><w:color w:val="000000" w:themeColor="text1"/><w:szCs w:val="28"/>`;
  const h2 = `<w:p><w:pPr><w:pStyle w:val="Heading2"/><w:rPr>${h2Props}</w:rPr></w:pPr>${bookmark(991, signMark, `<w:r><w:rPr>${h2Props}</w:rPr><w:t>Sign-off</w:t></w:r>`)}</w:p>`;

  const widths = [3128, 1989, 1481, 2680];
  const cellBorders = ["top", "left", "bottom", "right"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join("");
  const props = `<w:rPr>${fonts}<w:i w:val="0"/><w:color w:val="000000"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US"/></w:rPr>`;
  const cell = (value: string, width: number, fill: string, center: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:tcBorders>${cellBorders}</w:tcBorders><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="Header"/>${center ? '<w:jc w:val="center"/>' : ""}${props}</w:pPr>${value ? `<w:r>${props}${text(value)}</w:r>` : ""}</w:p></w:tc>`;
  const head = ["Role", "Name", "Date", "Signature"].map((t, i) => cell(t, widths[i], "DEEAF6", i > 0)).join("");
  const rows = layout.signOff.map((p) => `<w:tr><w:trPr><w:trHeight w:val="754"/></w:trPr>${cell(p.role, widths[0], "F2F2F2", false)}${cell(p.name, widths[1], "FFFFFF", true)}${cell("", widths[2], "FFFFFF", true)}${cell("", widths[3], "FFFFFF", true)}</w:tr>`).join("");
  const table = `<w:tbl><w:tblPr><w:tblW w:w="9278" w:type="dxa"/><w:tblBorders>${BORDER("auto")}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${widths.map((x) => `<w:gridCol w:w="${x}"/>`).join("")}</w:tblGrid><w:tr>${head}</w:tr>${rows}</w:tbl>`;
  return h1 + h2 + "<w:p/>" + table + "<w:p/>";
}

/** Rough page for the contents list; Word replaces it with the real number when it refreshes the field. */
function estimatePages(layout: FsdLayout) {
  const LINES_PER_PAGE = 40;
  const size = (s: LayoutSection) => {
    let lines = 3 + (s.intro ? 2 : 0) + (s.fields ? s.fields.length * 3 : 0);
    for (const t of s.tokens) {
      if (t.type === "table") lines += ((t as Tokens.Table).rows.length + 1) * 2.5;
      else if (t.type === "list") lines += (t as Tokens.List).items.length * 1.4;
      else if (t.type !== "space") lines += Math.ceil(t.raw.length / 95) + 1;
    }
    return lines;
  };
  let lines = 22; // requirement detail
  const pages = layout.sections.map((s) => {
    const page = 4 + Math.floor(lines / LINES_PER_PAGE);
    lines += size(s);
    return page;
  });
  return { pages, closing: 4 + Math.floor(lines / LINES_PER_PAGE) };
}

function bulletlessNumbering(numbering: string, lists: number) {
  const levels = [0, 1].map((i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + i * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join("");
  const abstract = `<w:abstractNum w:abstractNumId="${LIST_ABSTRACT}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
  const nums = Array.from({ length: lists }, (_, i) => `<w:num w:numId="${LIST_FIRST_NUM + i}"><w:abstractNumId w:val="${LIST_ABSTRACT}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join("");
  const at = numbering.search(/<w:num w:numId=/);
  return numbering.slice(0, at) + abstract + numbering.slice(at).replace("</w:numbering>", `${nums}</w:numbering>`);
}

/** The template's customer logo slot (the reference's logo), in EMU. SuperNova's own logo is the other picture. */
const CLIENT_LOGO = { file: "word/media/image2.png", width: 1485900, height: 573405 };

/** Puts this customer's logo in the template's customer slot, scaled to keep its shape, or takes the slot out. */
async function placeClientLogo(zip: JSZip, client: FsdLayout["client"]) {
  const ext = client?.logoType === "image/png" ? "png" : "jpg";
  const size = client?.logo ? fitInto(imageSize(client.logo, client.logoType ?? ""), CLIENT_LOGO) : null;
  for (const header of ["header1", "header2"]) {
    const relsName = `word/_rels/${header}.xml.rels`;
    let rels = await zip.file(relsName)!.async("string");
    const id = rels.match(/Id="(rId\d+)"[^>]*Target="media\/image2\.png"/)?.[1];
    if (!id) continue;
    let xml = await zip.file(`word/${header}.xml`)!.async("string");
    if (size) {
      rels = rels.replace('Target="media/image2.png"', `Target="media/client-logo.${ext}"`);
      xml = xml.split(`cx="${CLIENT_LOGO.width}" cy="${CLIENT_LOGO.height}"`).join(`cx="${size.width}" cy="${size.height}"`);
    } else {
      xml = xml.replace(new RegExp(`<w:r>(?:(?!</w:r>)[\\s\\S])*?r:embed="${id}"[\\s\\S]*?</w:r>`), "");
      rels = rels.replace(new RegExp(`<Relationship Id="${id}"[^>]*/>`), "");
    }
    zip.file(relsName, rels, { createFolders: false });
    zip.file(`word/${header}.xml`, xml, { createFolders: false });
  }
  zip.remove(CLIENT_LOGO.file);
  if (size && client?.logo) zip.file(`word/media/client-logo.${ext}`, client.logo, { createFolders: false, binary: true });
}

export async function buildFsdDocx(input: FsdDocumentInput): Promise<Buffer> {
  const layout = buildFsdLayout(input);
  const zip = await JSZip.loadAsync(fs.readFileSync(templateFile("fsd-template.docx")));
  const read = (name: string) => zip.file(name)!.async("string");
  const write = (name: string, content: string) => zip.file(name, content, { createFolders: false });
  const w = new Writer();

  const { pages, closing } = estimatePages(layout);
  const mark = (n: number) => `_Toc1952${String(84780 + n)}`;
  const entries: TocEntry[] = [
    { label: "Revision history", bookmark: mark(899), page: 3, level: 1 },
    { label: "Requirement detail", bookmark: mark(0), page: 4, level: 1 },
    { label: layout.specifications, bookmark: mark(1), page: 3, level: 1 },
    ...layout.sections.map((s, i): TocEntry => ({ label: s.title, number: i + 1, bookmark: mark(i + 2), page: pages[i], level: 1 })),
    { label: "Finalization", bookmark: mark(900), page: closing, level: 1 },
    { label: "Sign-off", bookmark: mark(901), page: closing, level: 2 },
  ];

  // Workflow process flows become pictures; the rest of the document is text and tables.
  const images: { name: string; data: Buffer }[] = [];
  const sections = await Promise.all(
    layout.sections.map(async (s) => {
      const drawn = s.flow ? drawFlow(s.flow) : null;
      if (!drawn) return s;
      images.push({ name: `flow-${images.length + 1}.png`, data: await flowPng(drawn) });
      return { ...s, diagram: { rId: `rIdFlow${images.length}`, width: drawn.width, height: drawn.height } };
    }),
  );

  const specifications = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${bookmark(2, mark(1), `<w:r>${text(layout.specifications)}</w:r>`)}</w:p>`;
  const body = [
    cover(layout),
    toc(entries),
    revisionHistory(layout, w, mark(899)),
    requirementDetail(layout, w, mark(0)),
    specifications,
    ...sections.map((s, i) => section(s, w, mark(i + 2), i + 10)),
    signOff(layout, mark(900), mark(901)),
  ].join("");

  const template = await read("word/document.xml");
  const open = template.indexOf("<w:body>") + "<w:body>".length;
  write("word/document.xml", template.slice(0, open) + body + template.slice(open));
  write("word/numbering.xml", bulletlessNumbering(await read("word/numbering.xml"), w.lists));

  write(
    "word/footer1.xml",
    (await read("word/footer1.xml"))
      .replace("{{CREATED_BY}}", esc(layout.footer.createdBy))
      .replace("{{CREATED_DATE}}", layout.footer.createdDate)
      .replace("{{CHANGED_DATE}}", layout.footer.changedDate)
      .replace("{{VERSION}}", esc(layout.footer.version))
      .replace(">Functional Specification<", `>${layout.kind}<`),
  );

  if (images.length) {
    const rels = images.map((img, i) => `<Relationship Id="rIdFlow${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.name}"/>`).join("");
    write("word/_rels/document.xml.rels", (await read("word/_rels/document.xml.rels")).replace("</Relationships>", `${rels}</Relationships>`));
    for (const img of images) zip.file(`word/media/${img.name}`, img.data, { createFolders: false, binary: true });
  }

  if (w.links.length) {
    const links = w.links.map((href, i) => `<Relationship Id="rIdLink${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(href)}" TargetMode="External"/>`).join("");
    write("word/_rels/document.xml.rels", (await read("word/_rels/document.xml.rels")).replace("</Relationships>", `${links}</Relationships>`));
  }

  await placeClientLogo(zip, layout.client);

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  write(
    "docProps/core.xml",
    (await read("docProps/core.xml"))
      .replace(/<dc:title>[^<]*<\/dc:title>/, `<dc:title>${esc(layout.documentTitle)}</dc:title>`)
      .replace(/(<dcterms:created [^>]*>)[^<]*/, `$1${now}`)
      .replace(/(<dcterms:modified [^>]*>)[^<]*/, `$1${now}`),
  );
  write("docProps/app.xml", (await read("docProps/app.xml")).replace(/<Company>[^<]*<\/Company>/, `<Company>${esc(layout.cover[0][1])}</Company>`));

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
