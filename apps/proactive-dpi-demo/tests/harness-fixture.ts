// A real Durable Pi harness on a temp SQLite file, driven by a scripted faux model. No network, no real model.
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
  Harness,
  configure,
  createRegistry,
  type Conversation,
  type ConversationId,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Incident } from "../shared/types.ts";
import { Incidents, createExtensions } from "../apps/proactive-dpi-be/src/extensions.ts";
import type { WatchStore } from "../apps/proactive-dpi-be/src/watch-store.ts";

export { ctx, fauxAssistantMessage, fauxText, fauxToolCall };
export type { Conversation };

export type ToolStep = { name: string; args: Record<string, unknown> };

/** One scripted assistant turn that calls these tools in order. */
export const callTools = (...steps: ToolStep[]): FauxResponseStep =>
  fauxAssistantMessage(
    [fauxText("Working."), ...steps.map((s, i) => fauxToolCall(s.name, s.args as never, { id: `call_${Math.random().toString(36).slice(2, 8)}_${i}` }))],
    { stopReason: "toolUse" },
  );
export const say = (text: string): FauxResponseStep => fauxAssistantMessage(fauxText(text));

export async function openFixture(opts: { dir: string; repoDir: string; store: WatchStore }) {
  const incidentChanges: { incident: Incident; announce: boolean }[] = [];
  const extensions = createExtensions({
    store: opts.store,
    incidentChanged: (incident, announce) => incidentChanges.push({ incident, announce }),
  });
  const models = createModels();
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "echo", name: "Faux", contextWindow: 128000, maxTokens: 8192 }],
    tokensPerSecond: 5000,
  });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(extensions.OpsTools);
  registry.install(extensions.Desk);
  registry.install(extensions.IncidentAgent);
  const shellEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(opts.dir, "agent.sqlite")),
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? opts.repoDir, shellEnv }),
      settings: { progress: { partialIntervalMs: 50, outputIntervalMs: 50 }, toolExecution: "sequential" },
      onReport: () => {},
    },
    ctx,
  );

  const model = { provider: "faux", modelId: "echo" };
  const root = await harness.root(ctx, {
    agent: { model, thinkingLevel: "off", extensions: [extensions.OpsTools, extensions.Desk], cwd: opts.repoDir },
  });
  harness.resume();

  /** Opens an incident the way Ops.openIncident does: its record and its conversation in one commit. */
  async function openIncident(over: Partial<Incident> & { worktree: string; fingerprint?: string }) {
    return harness.commit(async (tx) => {
      const doc = await tx.doc(Incidents);
      doc.seq += 1;
      const id = `INC-${String(doc.seq).padStart(4, "0")}`;
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, conversation.id, {
        model,
        thinkingLevel: "off",
        extensions: [CodingTools, extensions.OpsTools, extensions.IncidentAgent],
        cwd: over.worktree,
      });
      const now = Date.now();
      const incident: Incident = {
        id,
        title: "checkout-api POST /v1/checkout: TypeError failures",
        fingerprint: over.fingerprint ?? "checkout-api · POST /v1/checkout · TypeError",
        service: "checkout-api",
        trigger: "incident",
        status: "starting",
        summary: "starting",
        conversationId: conversation.id as number,
        branch: `incident/${id.toLowerCase()}`,
        openedAt: now,
        updatedAt: now,
        evidence: { logIds: [], firstSeen: new Date(now).toISOString(), revision: "r", commit: null },
        report: { rootCause: null, fix: null, tests: null, commit: null, diffStat: null, deployedRevision: null },
        timeline: [{ at: now, status: "starting", summary: "opened" }],
        announced: { opened: true, ready: false },
        ...over,
      };
      doc.items[id] = incident;
      return incident;
    }, ctx);
  }

  async function conversationOf(incident: Incident): Promise<Conversation> {
    const c = await harness.conversation(incident.conversationId as ConversationId, ctx);
    if (!c) throw Error("no conversation");
    return c;
  }

  let n = 0;
  /** Script the model and send one message. `done()` waits until the agent has answered and returns the tool results this message produced. */
  async function start(conversation: Conversation, script: FauxResponseStep[], content = "go") {
    const already = (await toolResults(conversation)).length;
    faux.setResponses(script);
    const submission = await conversation.submit({ type: "input", content, requestId: `req-${++n}` }, ctx);
    return {
      id: submission.id as number,
      done: async () => {
        const record = await (await harness.submission(submission.id as SubmissionId, ctx))!.wait(ctx);
        return { record, results: (await toolResults(conversation)).slice(already) };
      },
    };
  }
  const run = async (conversation: Conversation, script: FauxResponseStep[], content = "go") =>
    (await start(conversation, script, content)).done();

  async function toolResults(conversation: Conversation) {
    const view = await conversation.viewState(ctx);
    try {
      const entries = JSON.parse(JSON.stringify(view.value.entries)) as { model?: { role: string; toolName?: string; content?: unknown; isError?: boolean }[] }[];
      return entries
        .flatMap((e) => e.model ?? [])
        .filter((m) => m.role === "toolResult")
        .map((m) => ({
          tool: m.toolName ?? "",
          isError: Boolean(m.isError),
          text: Array.isArray(m.content) ? (m.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("") : String(m.content ?? ""),
        }));
    } finally {
      view.dispose();
    }
  }

  return {
    harness, root, faux, extensions, incidentChanges, openIncident, conversationOf, start, run, toolResults,
    incidents: async () => Object.values((await harness.snapshot(Incidents, ctx))?.items ?? {}) as Incident[],
    close: () => harness.close(ctx),
  };
}
