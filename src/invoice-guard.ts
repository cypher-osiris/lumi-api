/**
 * InvoiceGuard Durable Object: a strongly consistent "redeemed once" set for
 * x402 invoice ids. A Durable Object processes requests one at a time, so the
 * read-then-write in /claim is atomic. Entries expire via an alarm.
 */

interface DOStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(opts?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}
interface DOState {
  storage: DOStorage;
}

export class InvoiceGuard {
  constructor(private state: DOState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/claim") return new Response("not found", { status: 404 });
    const { id, ttlSeconds } = (await request.json()) as { id?: string; ttlSeconds?: number };
    if (!id || typeof id !== "string" || id.length > 256) return new Response("bad request", { status: 400 });

    const key = `inv:${id}`;
    const now = Date.now();
    const until = await this.state.storage.get<number>(key);
    if (until !== undefined && until > now) return new Response("already claimed", { status: 409 });

    await this.state.storage.put(key, now + Math.max(60, Number(ttlSeconds) || 600) * 1000);
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(now + 3600_000);
    return new Response("claimed", { status: 200 });
  }

  /** Hourly cleanup of expired invoice ids. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.state.storage.list<number>({ prefix: "inv:" });
    const expired = [...entries].filter(([, until]) => until <= now).map(([k]) => k);
    for (let i = 0; i < expired.length; i += 128) await this.state.storage.delete(expired.slice(i, i + 128));
    if (entries.size > expired.length) await this.state.storage.setAlarm(now + 3600_000);
  }
}
