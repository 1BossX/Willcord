import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai/compat';
import { Type } from 'typebox';
import { SqliteCheckpointStore } from './sqlite-checkpoint.js';
import { SqliteWorkerLedger } from './worker-ledger.js';
import { ExecutionCoordinator } from './execution-coordinator.js';
import { ROLE_TOOLS } from './pi-runtime.js';
export async function coordinatorFixture(root, { execute = async () => ({ content: [{ type: 'text', text: 'original result' }], details: {} }), bootId = 'boot' } = {}) {
  const store = new SqliteCheckpointStore(join(root, 'host.sqlite'));
  const ledger = new SqliteWorkerLedger(join(root, 'worker.sqlite'), { workerId: 'worker', bootId });
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false });
  await runtime.setRuntimeApiKey('openai', 'test-only');
  const coordinator = new ExecutionCoordinator({ store, ledger, verifiedIdentity: ledger.identity,
    trustedTarget: { workerId: 'worker', ledgerId: ledger.identity.ledgerId, workspaceId: 'workspace', workspaceVersion: 'v1' }, sessionId: 'session', execute,
    sessionOptions: { cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), model: getModel('openai', 'gpt-4o-mini'), modelRuntime: runtime },
    tools: ROLE_TOOLS.worker.map((name) => ({ name, label: name, description: name, parameters: Type.Object({ input: Type.Optional(Type.String()) }) })),
  });
  return { coordinator, store, ledger, close() { store.close(); ledger.close(); } };
}
