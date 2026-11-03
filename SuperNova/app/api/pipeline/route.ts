// One endpoint for all pipeline actions; returns the fresh page state.
import {
  addFsdComment, applyFsdChange, approveFsd, changeWricef, createLinkedPair, createRequirement, discardFsdChange, exportStep, generateCodeStep,
  generateFsdStep, generateTsStep, interviewStep, proposeFsdChange, reviewStep, reviseAnswer, saveFsdEdit, setQuestionResolved,
  setRequirementClient, StepError, type DocType,
} from "@/lib/pipeline";
import { LlmError } from "@/lib/llm";
import { pageState } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  action: string;
  id?: number;
  text?: string;
  fsdVersionId?: number;
  force?: boolean;
  summary?: string;
  changeId?: number;
  changeType?: "MINOR" | "MAJOR";
  section?: string;
  resolved?: boolean;
  client?: { name?: string; logo?: string; logoType?: string };
  choice?: string;
  project?: string;
  docType?: DocType;
  wricef?: string;
  confirmed?: boolean;
};

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  let id = body.id ?? null;
  try {
    switch (body.action) {
      case "start":
        if (body.choice === "mixed") {
          id = createLinkedPair(body.text ?? "", body.client, body.project).report;
        } else {
          id = createRequirement(body.text ?? "", body.client, { choice: body.choice, project: body.project });
        }
        await interviewStep(id);
        break;
      case "reviseAnswer":
        await reviseAnswer(need(id), body.text ?? "");
        break;
      case "changeWricef":
        await changeWricef(need(id), body.wricef ?? "", !!body.confirmed);
        break;
      case "generateTs":
        await generateTsStep(need(id));
        break;
      case "answer":
        await interviewStep(need(id), body.text);
        break;
      case "setClient":
        setRequirementClient(need(id), body.client ?? {});
        break;
      case "finishInterview":
        await interviewStep(need(id), body.text, true);
        break;
      case "generateFsd":
        await generateFsdStep(need(id));
        break;
      case "saveFsd":
        saveFsdEdit(need(id), body.text ?? "", body.summary, body.docType);
        break;
      case "proposeChange":
        await proposeFsdChange(need(id), body.text, body.fsdVersionId, body.changeId, body.docType);
        break;
      case "applyChange":
        await applyFsdChange(need(id), body.changeId ?? 0, body.changeType);
        break;
      case "discardChange":
        discardFsdChange(need(id), body.changeId ?? 0);
        break;
      case "addComment":
        addFsdComment(need(id), body.fsdVersionId ?? 0, body.section ?? "", body.text ?? "");
        break;
      case "resolveQuestion":
        setQuestionResolved(need(id), body.fsdVersionId ?? 0, body.text ?? "", body.resolved ?? true);
        break;
      case "approve":
        approveFsd(need(id), body.fsdVersionId ?? 0);
        break;
      case "generateCode":
        await generateCodeStep(need(id));
        break;
      case "review":
        await reviewStep(need(id));
        break;
      case "export":
        await exportStep(need(id), !!body.force);
        break;
      default:
        throw new StepError(`Unknown action ${body.action}`);
    }
    return Response.json({ ok: true, state: pageState(id) });
  } catch (e) {
    const known = e instanceof StepError || e instanceof LlmError;
    if (!known) console.error(e);
    return Response.json({ ok: false, error: (e as Error).message, state: pageState(id) }, { status: known ? 400 : 500 });
  }
}

function need(id: number | null): number {
  if (!id) throw new StepError("No requirement selected.");
  return id;
}
