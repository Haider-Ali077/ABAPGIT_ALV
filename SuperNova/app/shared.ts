import { Marked } from "marked";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type State = any;

export type StepProps = {
  state: State;
  busy: boolean;
  run: (action: string, label: string, payload?: Record<string, unknown>) => Promise<void>;
  go: (step: number) => void;
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const markdown = new Marked({ renderer: { html: (token: { text: string }) => escapeHtml(token.text) } });

export const renderMarkdown = (text: string) => markdown.parse(text) as string;
export const fmt = (iso: string) => new Date(iso).toLocaleString();
export const statusLabel = (status: string) => ({ DRAFT: "Draft", APPROVED: "Approved", SUPERSEDED: "Superseded" })[status] ?? status;
export const docxLink = (versionId: number) => `/api/download?fsd=${versionId}&format=docx`;
export const pdfLink = (versionId: number) => `/api/download?fsd=${versionId}&format=pdf`;

/**
 * Like fetch().json(), for the app's own API. While next dev recompiles a route it can answer once with an
 * HTML 404 page. The route never ran, so asking again is safe. Any other non-JSON answer is a real failure.
 */
export async function fetchJson(url: string, init?: RequestInit) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.headers.get("content-type")?.includes("application/json")) return res.json();
    if (res.status !== 404 || attempt >= 4) throw new Error(`The server did not answer properly (HTTP ${res.status}). Reload the page and try again.`);
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
}
