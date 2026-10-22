/**
 * Throwaway XRPL TESTNET wallets for the demo. Seeds live only in
 * .testnet/wallets.json (git-ignored, mode 600). Never put mainnet keys here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Client, Wallet } from "xrpl";

/** Tried in order; override with XRPL_TESTNET_WS. Port 443 endpoints work behind strict egress firewalls. */
export const TESTNET_WS_CANDIDATES = [
  process.env.XRPL_TESTNET_WS,
  "wss://s.altnet.rippletest.net:51233",
  "wss://testnet.xrpl-labs.com",
].filter(Boolean) as string[];

/** Connect to the first reachable XRPL Testnet node and confirm network_id 1. */
export async function connectTestnet(): Promise<{ client: Client; wsUrl: string }> {
  let lastErr: unknown;
  for (const url of TESTNET_WS_CANDIDATES) {
    const client = new Client(url, { connectionTimeout: 8000 });
    try {
      await client.connect();
      const info = await client.request({ command: "server_info" });
      if ((info.result.info as { network_id?: number }).network_id !== 1) {
        await client.disconnect();
        throw new Error(`${url} is not XRPL Testnet (network_id != 1)`);
      }
      return { client, wsUrl: url };
    } catch (e) {
      lastErr = e;
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
  throw new Error(`No XRPL Testnet node reachable: ${String(lastErr)}`);
}
export const DIR = join(process.cwd(), ".testnet");
export const WALLETS_FILE = join(DIR, "wallets.json");

export interface TestnetWallets {
  network: "xrpl:1";
  created: string;
  payer: { address: string; seed: string };
  receiver: { address: string; seed: string };
}

export async function balanceXrp(client: Client, address: string): Promise<number> {
  try {
    const r = await client.request({ command: "account_info", account: address, ledger_index: "validated" });
    return Number(r.result.account_data.Balance) / 1_000_000;
  } catch {
    return 0;
  }
}

export async function ensureTestnetWallets(log = console.log): Promise<TestnetWallets> {
  const { client } = await connectTestnet();
  try {
    let w: TestnetWallets | undefined;
    if (existsSync(WALLETS_FILE)) w = JSON.parse(readFileSync(WALLETS_FILE, "utf8"));

    if (!w) {
      log("Creating throwaway testnet wallets via the XRPL testnet faucet...");
      const payer = (await client.fundWallet()).wallet;
      const receiver = (await client.fundWallet()).wallet;
      w = {
        network: "xrpl:1",
        created: new Date().toISOString(),
        payer: { address: payer.classicAddress, seed: payer.seed! },
        receiver: { address: receiver.classicAddress, seed: receiver.seed! },
      };
      mkdirSync(DIR, { recursive: true });
      writeFileSync(WALLETS_FILE, JSON.stringify(w, null, 2));
      chmodSync(WALLETS_FILE, 0o600);
      log(`Saved to ${WALLETS_FILE} (git-ignored).`);
    }

    for (const who of ["payer", "receiver"] as const) {
      const bal = await balanceXrp(client, w[who].address);
      if (bal < 5) {
        log(`Topping up ${who} ${w[who].address} from the faucet (balance ${bal} XRP)...`);
        await client.fundWallet(Wallet.fromSeed(w[who].seed));
      }
    }
    return w;
  } finally {
    await client.disconnect();
  }
}
