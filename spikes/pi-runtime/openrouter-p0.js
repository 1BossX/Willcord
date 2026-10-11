import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai/compat';
import { Type } from 'typebox';
import { createPiSession, ROLE_TOOLS } from './pi-runtime.js';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error('Set OPENROUTER_API_KEY in the process environment before running this live check.');
}

const provider = 'openrouter';
const model = getModel(provider, 'deepseek/deepseek-v4.1-flash');
assert.ok(model, 'the pinned Pi model catalog must contain DeepSeek V4.1 Flash');

const root = await mkdtemp(join(tmpdir(), 'willcord-openrouter-p0-'));
let session;
let sessionManager;
let modelRuntime;
let sawProviderDelta = false;
let abortTask;
let toolExecutions = 0;
let streamInvocations = 0;

try {
  modelRuntime = await ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(root, 'models.json'),
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey(provider, apiKey);
  sessionManager = SessionManager.create(root, join(root, 'sessions'));

  const tools = ROLE_TOOLS.worker.map((name) => ({
    name,
    label: name,
    description: `P0 cancellation probe ${name}`,
    parameters: Type.Object({ input: Type.Optional(Type.String()) }),
    execute: async () => {
      toolExecutions += 1;
      return { content: [{ type: 'text', text: 'unexpected tool execution' }], details: {} };
    },
  }));

  ({ session } = await createPiSession({
    role: 'worker',
    cwd: root,
    agentDir: join(root, 'agent'),
    sessionDir: join(root, 'sessions'),
    sessionManager,
    model,
    modelRuntime,
    customTools: tools,
    commitAssistantTurn: async () => {},
  }));

  const streamFunction = session.agent.streamFunction;
  session.agent.streamFunction = (...args) => {
    streamInvocations += 1;
    const options = args[2] ?? {};
    return streamFunction(args[0], args[1], {
      ...options,
      fetch: async (...fetchArgs) => {
        const response = await fetch(...fetchArgs);
        if (!response.body) return response;
        const reader = response.body.getReader();
        const body = new ReadableStream({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                controller.close();
                return;
              }
              controller.enqueue(chunk.value);
              if (!sawProviderDelta) {
                sawProviderDelta = true;
                // Abort only after the provider has delivered a real HTTP stream chunk.
                abortTask = session.abort();
              }
            } catch (error) {
              controller.error(error);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
    });
  };

  const prompt = session.prompt(
    'Write a detailed 1200-word explanation of how databases recover after a process crash. Do not call tools.',
  );
  await prompt;
  if (abortTask) await abortTask;

  if (!sawProviderDelta) {
    console.log(JSON.stringify({ ok: false, provider, model: model.id, streamInvocations }));
  }
  assert.equal(sawProviderDelta, true, 'the real provider must emit a delta before cancellation');
  assert.equal(toolExecutions, 0, 'cancellation must not execute a tool');
  assert.equal(session.isIdle, true, 'the Pi run must settle after cancellation');
  assert.ok(session.agent.state.messages.length > 0, 'Pi should retain its real provider transcript');

  console.log(JSON.stringify({
    ok: true,
    provider,
    model: model.id,
    sawProviderDelta,
    abortSignalSent: true,
    toolExecutions,
    sessionIdleAfterAbort: session.isIdle,
    finalUsage: 'not available because cancellation stopped the stream before its final usage event',
  }));
} finally {
  session?.dispose();
  await modelRuntime?.dispose?.();
  await rm(root, { recursive: true, force: true });
}
