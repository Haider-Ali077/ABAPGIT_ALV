// WRICEF classification: the first question for every requirement. Only Report and Workflow
// are built end to end; every other choice gets an honest message instead of a wrong specification.
// No I/O here, so the page and the server share it.

export type Wricef = "R" | "W";
export type ExecutionMode = "ONLINE" | "BACKGROUND";

export type Choice = {
  id: string;
  label: string;
  code: string; // the WRICEF letter, or "-" for choices that are not one category
  supported: boolean;
  hint: string;
  /** What starts when the choice is supported. */
  wricef?: Wricef;
  execution?: ExecutionMode;
  /** Report and Workflow parts created together and linked. */
  linked?: boolean;
  /** Why it is not supported and what to do instead. */
  message?: string;
};

export const CHOICES: Choice[] = [
  { id: "report", label: "Report", code: "R", supported: true, wricef: "R", execution: "ONLINE", hint: "Lists, ALV, analytics, reconciliation and exception reports" },
  { id: "workflow", label: "Workflow", code: "W", supported: true, wricef: "W", hint: "Approvals, routing, deadlines and escalations" },
  {
    id: "job", label: "Background job", code: "R", supported: true, wricef: "R", execution: "BACKGROUND",
    hint: "Runs as a report in the background, with variants and a job schedule",
  },
  {
    id: "mixed", label: "Report and workflow", code: "R + W", supported: true, linked: true,
    hint: "One business need with a report part and an approval part, created as two linked requirements",
  },
  {
    id: "interface", label: "Interface", code: "I", supported: false, hint: "IDoc, RFC, OData, file or API exchange",
    message: "Interfaces are not supported yet. SuperNova cannot write an interface specification or generate interface objects, so nothing has been created.",
  },
  {
    id: "conversion", label: "Conversion", code: "C", supported: false, hint: "Data migration and one-time loads",
    message: "Conversions and data migrations are not supported yet. SuperNova cannot write a migration specification or generate load programs, so nothing has been created.",
  },
  {
    id: "enhancement", label: "Enhancement", code: "E", supported: false, hint: "BAdI, user exit, enhancement spot",
    message: "Enhancements are not supported yet. SuperNova cannot write an enhancement specification or generate BAdI or exit code, so nothing has been created.",
  },
  {
    id: "form", label: "Form", code: "F", supported: false, hint: "Adobe Form, SmartForm, print output",
    message: "Forms and print output are not supported yet. SuperNova cannot write a form specification or generate form objects, so nothing has been created.",
  },
  {
    id: "custom", label: "Custom application or mixed", code: "-", supported: false, hint: "Several kinds of development in one request",
    message:
      "A custom application usually combines several kinds of development, such as screens, data storage, reports, approvals and interfaces. SuperNova can only take the Report and Workflow parts. Split the request: create the report part as a Report, the approval part as a Workflow, or both together with \"Report and workflow\". The other parts need a different tool.",
  },
];

export const wricefLabel = (w?: string | null) => (w === "W" ? "Workflow" : "Report");
export const wricefCode = (w?: string | null) => (w === "W" ? "W" : "R");

/** Words that usually mean another WRICEF type. Only a warning: the user decides, nothing is reclassified. */
const SIGNS: { label: string; pattern: RegExp }[] = [
  { label: "an Interface", pattern: /\b(idoc|rfc\b|bapi call|odata|web ?service|soap|rest api|edi\b|interface|middleware|cpi\b|pi\/po)/i },
  { label: "a Conversion", pattern: /\b(migration|migrate|data load|upload (of|the)? ?(legacy|master)|lsmw|legacy data|conversion program|one[- ]time load)/i },
  { label: "an Enhancement", pattern: /\b(badi|user[- ]exit|customer exit|enhancement spot|implicit enhancement|substitution|validation rule)/i },
  { label: "a Form", pattern: /\b(smart ?form|adobe form|sapscript|print (form|layout|output)|invoice print|purchase order print)/i },
];

export function otherTypeSigns(text: string): string[] {
  return SIGNS.filter((s) => s.pattern.test(text)).map((s) => s.label);
}
