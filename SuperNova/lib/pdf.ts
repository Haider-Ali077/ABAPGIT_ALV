// Builds the FSD as a PDF in the same company layout as the DOCX: both logos, cover table,
// contents, requirement detail, numbered specification, sign-off and the footer table.
import fs from "node:fs";
import PdfPrinter from "pdfmake";
import robotoFiles from "pdfmake/build/vfs_fonts.js";
import type { Content, TableCell, TableLayout, TDocumentDefinitions } from "pdfmake/interfaces";
import type { Token, Tokens } from "marked";
import { buildFsdLayout, columnShares, decodeEntities, templateFile, type FsdDocumentInput, type FsdLayout, type LayoutSection } from "./fsd-document";
import { fitInto, imageSize } from "./client";
import { drawFlow, flowPng } from "./flow-diagram";

const PAGE_WIDTH = 468; // US Letter less 1 inch margins, in points, as in the template
const CELL_PADDING = 4;
const LIGHT_BLUE = "#DEEAF6";
const RULE_BLUE = "#3399FF";
const TITLE_BLUE = "#2F5496";
const HEADING_BLUE = "#365F91";

const font = (name: string) => Buffer.from((robotoFiles as unknown as Record<string, string>)[name], "base64");
const printer = new PdfPrinter({
  Roboto: {
    normal: font("Roboto-Regular.ttf"),
    bold: font("Roboto-Medium.ttf"),
    italics: font("Roboto-Italic.ttf"),
    bolditalics: font("Roboto-MediumItalic.ttf"),
  },
  Courier: { normal: "Courier", bold: "Courier-Bold", italics: "Courier-Oblique", bolditalics: "Courier-BoldOblique" },
});

type Style = { bold?: boolean; italics?: boolean; decoration?: "lineThrough"; font?: string; color?: string; link?: string };
type Inline = Style & { text: string };

function inline(tokens: Token[] | undefined, s: Style = {}): Inline[] {
  return (tokens ?? []).flatMap((t): Inline[] => {
    switch (t.type) {
      case "strong":
        return inline((t as Tokens.Strong).tokens, { ...s, bold: true });
      case "em":
        return inline((t as Tokens.Em).tokens, { ...s, italics: true });
      case "del":
        return inline((t as Tokens.Del).tokens, { ...s, decoration: "lineThrough" });
      case "codespan":
        return [{ text: decodeEntities((t as Tokens.Codespan).text), ...s, font: "Courier" }];
      case "br":
        return [{ text: "\n", ...s }];
      case "link": {
        const link = t as Tokens.Link;
        return inline(link.tokens, /^https?:/i.test(link.href) ? { ...s, color: "#0563C1", link: link.href } : s);
      }
      default: {
        const text = t as Tokens.Text;
        return text.tokens?.length ? inline(text.tokens, s) : [{ text: decodeEntities(text.text ?? t.raw ?? ""), ...s }];
      }
    }
  });
}

const lines = (color: string, width = 0.5): TableLayout => ({
  hLineColor: () => color,
  vLineColor: () => color,
  hLineWidth: () => width,
  vLineWidth: () => width,
  paddingLeft: () => CELL_PADDING,
  paddingRight: () => CELL_PADDING,
  paddingTop: () => 3,
  paddingBottom: () => 3,
});

function fieldTable(rows: { text: string; cell: TableCell }[][]): Content {
  const wide = rows[0].length > 4;
  const widths = columnShares(rows.map((r) => r.map((c) => c.text)), wide ? 4.6 : 5).map((share) => share * PAGE_WIDTH - CELL_PADDING * 2 - 1);
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths,
      body: rows.map((row, r) =>
        row.map(({ cell }, c) => ({ ...(cell as object), ...(r === 0 ? { fillColor: LIGHT_BLUE, bold: true } : {}), ...(c > 0 && !wide ? { alignment: "center" } : {}) }) as TableCell),
      ),
    },
    layout: lines(RULE_BLUE, 0.75),
    fontSize: wide ? 9 : 10,
    margin: [0, 2, 0, 10],
  };
}

function list(l: Tokens.List): Content {
  const items = l.items.map((item): Content => {
    const own = item.tokens.filter((t) => t.type !== "list");
    const nested = item.tokens.filter((t) => t.type === "list") as Tokens.List[];
    const text = { text: own.flatMap((t) => inline((t as Tokens.Text).tokens ?? [t])) };
    return nested.length ? { stack: [text, ...nested.map(list)] } : text;
  });
  return l.ordered ? { ol: items, margin: [14, 0, 0, 8] } : { ul: items, margin: [14, 0, 0, 8] };
}

function blocks(tokens: Token[]): Content[] {
  return tokens.flatMap((t): Content[] => {
    switch (t.type) {
      case "heading":
        return [{ text: inline((t as Tokens.Heading).tokens), style: "sub" }];
      case "paragraph":
        return [{ text: inline((t as Tokens.Paragraph).tokens), margin: [0, 3, 0, 3] }];
      case "list":
        return [list(t as Tokens.List)];
      case "table": {
        const tb = t as Tokens.Table;
        const head = tb.header.map((c) => ({ text: decodeEntities(c.text), cell: { text: inline(c.tokens) } }));
        return [fieldTable([head, ...tb.rows.map((r) => r.map((c) => ({ text: decodeEntities(c.text), cell: { text: inline(c.tokens) } })))])];
      }
      case "code":
        return [{ text: (t as Tokens.Code).text, font: "Courier", fontSize: 9, margin: [0, 0, 0, 6], preserveLeadingSpaces: true }];
      case "blockquote":
        return blocks((t as Tokens.Blockquote).tokens);
      default:
        return [];
    }
  });
}

const box = (title: string, content: Content[], minHeight: number): Content => ({
  table: { widths: [PAGE_WIDTH - CELL_PADDING * 2 - 1], heights: (row: number) => (row === 1 ? minHeight : 16), body: [[{ text: title, bold: true, fillColor: LIGHT_BLUE }], [{ stack: content }]] },
  layout: lines("#000000"),
  fontSize: 10.5,
  margin: [0, 8, 0, 12],
});

function section(s: LayoutSection & { diagram?: { image: string; width: number; height: number } }, index: number): Content[] {
  const out: Content[] = [{ text: `${index + 1}.  ${s.title}`, style: "numbered", tocItem: true, tocStyle: { fontSize: 10.5 }, tocMargin: [0, 2, 0, 2] }];
  if (s.intro) out.push({ ul: [{ text: s.intro, color: "#FF0000" }], margin: [14, 0, 0, 8] });
  if (s.fields) out.push(fieldTable(s.fields.map((r) => r.map((text) => ({ text, cell: { text } })))));
  out.push(...blocks(s.tokens));
  if (s.diagram) {
    const scale = Math.min(PAGE_WIDTH / s.diagram.width, 560 / s.diagram.height);
    out.push(
      { image: s.diagram.image, width: s.diagram.width * scale, height: s.diagram.height * scale, alignment: "center", margin: [0, 6, 0, 2] },
      { text: "Process flow diagram, drawn from the table above", italics: true, fontSize: 9, color: "#595959", alignment: "center", margin: [0, 0, 0, 10] },
    );
  }
  return out;
}

function revisionHistory(layout: FsdLayout): Content[] {
  return [
    { text: "Revision history", style: "major", pageBreak: "before", tocItem: true, tocStyle: { fontSize: 10.5 }, tocMargin: [0, 2, 0, 2] },
    fieldTable([["Version", "Date", "Status", "Description of change"], ...layout.revisions].map((r) => r.map((text) => ({ text, cell: { text } })))),
  ];
}

function cover(layout: FsdLayout): Content[] {
  return [
    { text: layout.heading, style: "title", margin: [0, 70, 0, 70] },
    {
      table: {
        widths: [160, PAGE_WIDTH - 160 - CELL_PADDING * 4 - 3],
        body: layout.cover.map(([label, value]) => [{ text: label || " ", bold: true, fillColor: LIGHT_BLUE }, { text: value || " " }]),
      },
      layout: lines("#000000"),
      fontSize: 10.5,
    },
    { text: "", pageBreak: "after" },
  ];
}

function signOff(layout: FsdLayout): Content[] {
  const widths = [150, 100, 70, PAGE_WIDTH - 320 - CELL_PADDING * 8 - 5];
  const row = (cells: string[], fill: string, firstFill: string) =>
    cells.map((text, i) => ({ text, bold: true, alignment: i > 0 ? "center" : "left", fillColor: i === 0 ? firstFill : fill, margin: [0, 7, 0, 7] }));
  return [
    { text: "Finalization", style: "major", tocItem: true, tocStyle: { fontSize: 10.5 }, tocMargin: [0, 2, 0, 2] },
    { text: "Sign-off", style: "sub", tocItem: true, tocStyle: { fontSize: 10.5 }, tocMargin: [12, 2, 0, 2] },
    {
      table: {
        widths,
        dontBreakRows: true,
        body: [row(["Role", "Name", "Date", "Signature"], LIGHT_BLUE, LIGHT_BLUE), ...layout.signOff.map((p) => row([p.role, p.name, "", ""], "#FFFFFF", "#F2F2F2"))],
      },
      layout: lines("#000000"),
      fontSize: 10.5,
      margin: [0, 6, 0, 0],
    },
  ];
}

export async function buildFsdPdf(input: FsdDocumentInput): Promise<Buffer> {
  const layout = buildFsdLayout(input);
  const supernova = `data:image/jpeg;base64,${fs.readFileSync(templateFile("logo-supernova.jpg")).toString("base64")}`;
  const customer = layout.client?.logo ? layout.client : undefined;
  const logoSize = customer ? fitInto(imageSize(customer.logo!, customer.logoType ?? ""), { width: 117, height: 45 }) : null;
  const images: Record<string, string> = { supernova };
  if (customer) images.client = `data:${customer.logoType};base64,${Buffer.from(customer.logo!).toString("base64")}`;

  const sections = await Promise.all(
    layout.sections.map(async (s, i) => {
      const drawn = s.flow ? drawFlow(s.flow) : null;
      if (!drawn) return s;
      images[`flow${i}`] = `data:image/png;base64,${(await flowPng(drawn)).toString("base64")}`;
      return { ...s, diagram: { image: `flow${i}`, width: drawn.width, height: drawn.height } };
    }),
  );

  const definition: TDocumentDefinitions = {
    info: { title: layout.documentTitle, creator: "SuperNova", producer: "SuperNova" },
    pageSize: "LETTER",
    pageMargins: [72, 90, 72, 92],
    defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.2 },
    styles: {
      title: { fontSize: 25, bold: true, color: TITLE_BLUE, alignment: "center" },
      major: { fontSize: 18, bold: true, color: HEADING_BLUE, margin: [0, 16, 0, 4] },
      numbered: { fontSize: 14, bold: true, color: HEADING_BLUE, margin: [0, 16, 0, 6] },
      sub: { fontSize: 12, bold: true, margin: [0, 10, 0, 4] },
    },
    // A heading must not sit alone at the foot of a page.
    pageBreakBefore: (node, following) => ["major", "numbered", "sub"].includes(String(node.style)) && (following ?? []).length === 0,
    header: () => ({
      columns: [
        logoSize ? { image: "client", width: logoSize.width, height: logoSize.height } : { text: "", width: 117 },
        { text: "", width: "*" },
        { image: "supernova", width: 115, height: 24, margin: [0, 9, 0, 0] },
      ],
      margin: [72, 22, 72, 0],
    }),
    footer: (page, pages) => ({
      table: {
        widths: [116, 76, 106, 80, 60],
        body: [
          [
            { text: layout.kind, bold: true, rowSpan: 2, margin: [0, 8, 0, 0] },
            { text: "Created By", alignment: "center" },
            { text: layout.footer.createdBy, bold: true },
            { text: layout.footer.createdDate, bold: true, alignment: "center" },
            { text: `Page ${page} of ${pages}`, alignment: "center" },
          ],
          [
            "",
            { text: "Changed By", alignment: "center" },
            "",
            { text: layout.footer.changedDate, bold: true, alignment: "center" },
            { text: layout.footer.version, alignment: "center" },
          ],
        ],
      },
      layout: lines("#000000"),
      fontSize: 9.5,
      margin: [58, 8, 58, 0],
    }),
    images,
    content: [
      ...cover(layout),
      { toc: { title: { text: "Table of Contents", fontSize: 20, bold: true, color: TITLE_BLUE, alignment: "center", margin: [0, 0, 0, 14] } } },
      ...revisionHistory(layout),
      { text: "Requirement detail", style: "major", pageBreak: "before", tocItem: true, tocStyle: { fontSize: 10.5 }, tocMargin: [0, 2, 0, 2] },
      box(layout.technical ? "Technical Overview" : "Description of Business Requirement (Purpose and Use)", blocks(layout.purpose), 86),
      box("Related Transactions", (layout.transactions.length ? layout.transactions : ["None"]).map((text) => ({ text })), 76),
      { text: layout.specifications, style: "major", tocItem: true, tocStyle: { fontSize: 10.5 }, tocMargin: [0, 2, 0, 2] },
      ...sections.flatMap(section),
      ...signOff(layout),
    ],
  };

  const doc = printer.createPdfKitDocument(definition);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
