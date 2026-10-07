import { coordinatorFixture } from './coordinator-test-support.js';
const [root] = process.argv.slice(2);
const f = await coordinatorFixture(root, { bootId: 'recovery-boot' });
const previousGeneration = f.coordinator.readJob('job').generation;
const transaction = f.store.db.transaction.bind(f.store.db);
f.store.db.transaction = (fn) => {
  const result = transaction(fn);
  const immediate = result.immediate;
  const wrapped = (...args) => result(...args);
  wrapped.immediate = (...args) => {
    const value = immediate(...args);
    // Kill only after the real opening transaction has committed its fence.
    if (f.coordinator.readJob('job').generation > previousGeneration) process.kill(process.pid, 'SIGKILL');
    return value;
  };
  wrapped.deferred = result.deferred;
  wrapped.exclusive = result.exclusive;
  return wrapped;
};
await f.coordinator.recover('job');
throw new Error('recovery opening crash window was not reached');
