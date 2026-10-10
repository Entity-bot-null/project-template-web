/** Thrown by withDeadline when the operation did not settle in time. */
export class DeadlineExceededError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no answer within ${String(timeoutMs)} ms`);
    this.name = 'DeadlineExceededError';
  }
}

/**
 * The operation's result, or DeadlineExceededError once `timeoutMs` has
 * passed, whichever comes first. The operation itself is not cancelled (a
 * query or a command already sent cannot be recalled): its late result, or
 * its late failure, is dropped.
 */
export async function withDeadline<T>(operation: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineExceededError(timeoutMs));
    }, timeoutMs);
  });
  const pending = Promise.resolve(operation);
  pending.catch(() => undefined); // an abandoned operation's late failure is not an error
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
