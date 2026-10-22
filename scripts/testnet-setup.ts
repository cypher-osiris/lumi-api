/** npm run testnet:setup  -> create/fund throwaway testnet payer + receiver wallets. */
import { ensureTestnetWallets, balanceXrp, connectTestnet } from "./testnet-lib";

const w = await ensureTestnetWallets();
const { client } = await connectTestnet();
console.log(`payer    ${w.payer.address}  ${await balanceXrp(client, w.payer.address)} XRP (testnet)`);
console.log(`receiver ${w.receiver.address}  ${await balanceXrp(client, w.receiver.address)} XRP (testnet)`);
await client.disconnect();
console.log("Seeds are in .testnet/wallets.json (git-ignored). Testnet only.");
