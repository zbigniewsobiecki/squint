/**
 * Tracks failed relationship annotations for retry.
 */
export class RelationshipRetryQueue {
  private failures = new Map<string, { fromId: number; toId: number; attempts: number; error: string }>();

  private key(fromId: number, toId: number): string {
    return `${fromId}:${toId}`;
  }

  add(fromId: number, toId: number, error: string): void {
    const k = this.key(fromId, toId);
    const existing = this.failures.get(k);
    this.failures.set(k, {
      fromId,
      toId,
      attempts: (existing?.attempts ?? 0) + 1,
      error,
    });
  }

  getRetryable(maxAttempts = 3): Array<{ fromId: number; toId: number }> {
    const result: Array<{ fromId: number; toId: number }> = [];
    for (const entry of this.failures.values()) {
      if (entry.attempts < maxAttempts) {
        result.push({ fromId: entry.fromId, toId: entry.toId });
      }
    }
    return result;
  }

  clear(): void {
    this.failures.clear();
  }

  get size(): number {
    return this.failures.size;
  }
}
