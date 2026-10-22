import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InvoiceGuard } from "../src/invoice-guard";

export const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf8"));

export const PAY_TO = "rUJvhZ513MnBQVBcNap9NPJmKDWdKjyhC5";
export const PAYER = "rBCpEBgyfwme3obwjCx95UzqKFbayPXAuV";
export const FACILITATOR = "https://facilitator.test";
export const DATA = "https://data.test/data";

export interface FakeFacilitator {
  verify: (body: any) => Response | Promise<Response>;
  settle: (body: any) => Response | Promise<Response>;
  calls: { path: string; body: any }[];
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** A fetch stub serving fixture data and a scriptable facilitator. */
export function makeFetch(fac: FakeFacilitator, opts: { dataDown?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(DATA)) {
      if (opts.dataDown) return new Response("down", { status: 503 });
      const name = url.slice(DATA.length + 1).replace(/\.json$/, "");
      return jsonResponse(200, fixture(name));
    }
    if (url.startsWith(FACILITATOR)) {
      const path = url.slice(FACILITATOR.length);
      const body = JSON.parse(String(init?.body ?? "{}"));
      fac.calls.push({ path, body });
      if (path === "/verify") return fac.verify(body);
      if (path === "/settle") return fac.settle(body);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export function happyFacilitator(tx = "A".repeat(64)): FakeFacilitator {
  return {
    calls: [],
    verify: () => jsonResponse(200, { isValid: true, payer: PAYER }),
    settle: (b) => jsonResponse(200, { success: true, transaction: tx, network: b.paymentRequirements.network, payer: PAYER }),
  };
}

/** Build a PAYMENT-SIGNATURE header the way the x402-xrpl SDK does (blob content is opaque to the server). */
export function paymentHeaderFor(accepted: any, invoiceId = accepted.extra.invoiceId) {
  const payload = { x402Version: 2, accepted, payload: { signedTxBlob: "12000022", invoiceId } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

export function decodeB64Json(h: string | null) {
  return h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null;
}

/** In-memory stand-in for a Durable Object namespace running the real InvoiceGuard class (serialized like a DO). */
export function fakeDurableObjectNamespace() {
  const objects = new Map<string, { guard: InvoiceGuard; queue: Promise<unknown> }>();
  const storageFor = () => {
    const m = new Map<string, unknown>();
    let alarm: number | null = null;
    return {
      get: async (k: string) => m.get(k) as any,
      put: async (k: string, v: unknown) => void m.set(k, v),
      delete: async (keys: string[]) => keys.filter((k) => m.delete(k)).length,
      list: async (o?: { prefix?: string }) => new Map([...m].filter(([k]) => !o?.prefix || k.startsWith(o.prefix))) as any,
      getAlarm: async () => alarm,
      setAlarm: async (t: number) => void (alarm = t),
    };
  };
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const key = String(id);
      if (!objects.has(key)) objects.set(key, { guard: new InvoiceGuard({ storage: storageFor() }), queue: Promise.resolve() });
      const o = objects.get(key)!;
      return {
        fetch: (input: string, init?: RequestInit) => {
          const run = o.queue.then(() => o.guard.fetch(new Request(input, init)));
          o.queue = run.catch(() => undefined);
          return run;
        },
      };
    },
  };
}
