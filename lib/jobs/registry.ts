import type { Job } from "./queue";

// What runs each kind of job. A handler finishes normally when the work is done and throws when
// it isn't; the worker records the error and tries again later.

export type JobHandler<P = Record<string, unknown>> = (payload: P, job: Job<P>) => Promise<void>;

export type HandlerSpec = {
  handler: JobHandler;
  // Recurring work: after each run (done or dead) the next one is queued this many seconds
  // later, and a worker queues one when it starts if none is waiting.
  everySeconds?: number;
  maxAttempts?: number;
};

const registry = new Map<string, HandlerSpec>();

export function registerHandler<P = Record<string, unknown>>(
  kind: string,
  handler: JobHandler<P>,
  opts: Omit<HandlerSpec, "handler"> = {},
): void {
  registry.set(kind, { ...opts, handler: handler as JobHandler });
}

export function unregisterHandler(kind: string): void {
  registry.delete(kind);
}

export function handlerFor(kind: string): HandlerSpec | undefined {
  return registry.get(kind);
}

export function registeredKinds(): string[] {
  return [...registry.keys()].sort();
}
