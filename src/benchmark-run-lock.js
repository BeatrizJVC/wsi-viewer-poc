// Shared across module copies in the same realm; tokens prevent stale releases.
const key = Symbol.for('oncomets.benchmark.run-lock.v1');
export function lockOwner() { return globalThis[key]?.owner ?? null; }
export function acquireBenchmarkLock(owner) {
  if (globalThis[key]) throw Error('Another WSI benchmark is running.');
  const token = { owner };
  globalThis[key] = token;
  return () => { if (globalThis[key] === token) delete globalThis[key]; };
}
export async function withBenchmarkLock(owner, operation) {
  const release = acquireBenchmarkLock(owner);
  try { return await operation(); } finally { release(); }
}
