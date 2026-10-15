# amahoropay-sdk

Single ES module, zero-framework dependency SDK for **AMHR** token payments via the `AmahoroGateway.sol` smart contract.

Works out of the box in **Vanilla JS**, **React**, **Next.js**, **React Native** — one source of truth for all Web3 (wallet connect, checkout, escrow, gasless relay EIP-3009, batch payouts, cross-chain swaps, amount formatting).

---

## Installation

### Vanilla JS (via CDN)

```html
<script src="https://cdn.jsdelivr.net/npm/ethers@6.9.0/dist/ethers.umd.min.js"></script>
<script type="module">
  import { createAmahoroPay } from 'https://cdn.jsdelivr.net/gh/divinrule/amahoropay-sdk@main/amahoropay-sdk.js';
  const pay = createAmahoroPay({ ethers, gatewayAddress: '0x...', tokenAddress: '0x...' });
</script>
```

Pin a version in production: replace `@main` with `@v1.1.0`. Rules: `@v1` = latest major, `@main` = latest push (short cache).

### React / Next.js / React Native

Copy `amahoropay-sdk.js` to your project (`src/lib/amahoropay-sdk.js`) then:

```js
import { createAmahoroPay } from '../lib/amahoropay-sdk';
```

React Native: the wallet (WalletConnect, MetaMask SDK mobile) provides an EIP-1193 provider. Inject it via `sdk.connect(provider)` at connect time.

---

## Configuration

```js
const pay = createAmahoroPay({
    ethers,                              // ethers instance (global UMD or `import { ethers } from 'ethers'`)
    ethereum,                            // optional: injected EIP-1193 provider (MetaMask, WalletConnect)
    gatewayAddress: '0x…',               // AmahoroGateway contract address
    tokenAddress:   '0x…',               // AMHR token address
    gatewayAbi:     undefined,           // optional: custom gateway ABI (uses embedded minimal ABI)
    tokenAbi:       undefined,           // optional: custom token ABI
    relayUrl:       'https://…/index.php?page=relay',  // gasless relay endpoint
    apiKey:         '',                  // API key for relay
    chainIdExpected: null,               // optional: verify network after connect
    decimals:       18,                  // token decimals (auto-fetched on connect if not provided)
    csrfToken:      '',                  // CSRF token for list APIs
    chains:         undefined            // optional: chain registry for switchChain()
});
```

---

## API Reference

| Method | Description |
|---|---|
| `connect(providerOverride?)` | Connect wallet. No arg = `window.ethereum`. With arg = injected EIP-1193 provider (RN/WalletConnect). Returns `{ provider, signer, address }` |
| `ensureChain()` | Verify `chainIdExpected` (throws if wrong network) |
| `switchChain(chain)` | **Cross-chain**: switch/add network via EIP-3085/3326. `chain` = `{ chainId, name?, rpc?, nativeCurrency?, explorer? }` or numeric chainId (looked up in `config.chains`). Returns resulting chainId. |
| `createCheckout(payer, merchant, amountTokens, expiry)` | Create checkout (merchant receives). Returns `{ tx, receipt, checkoutId }` |
| `payCheckout(checkoutId, ref?)` | Pay checkout. Optional `ref` (bytes32) for cross-chain settlement binding. |
| `settleCheckout(checkoutId, ref?)` | **Swap settlement**: authorized settler fronts payment. |
| `cancelCheckout(checkoutId)` | Cancel checkout. |
| `getCheckout(checkoutId)` | Fetch checkout details. |
| `listCheckouts(params?)` | Server-side paginated list: `{ limit?, offset? }`. |
| `createEscrow(merchant, amountTokens, ref?, releaseDelaySec, expiresDelaySec)` | Create escrow. Returns `{ tx, receipt, escrowId }`. |
| `depositEscrow(escrowId)` / `releaseEscrow(escrowId)` / `refundEscrow(escrowId)` / `sweepExpiredEscrow(escrowId)` | Escrow lifecycle. |
| `getEscrow(escrowId)` | Fetch escrow details. |
| `listEscrows(params?)` | Server-side paginated list. |
| `payMerchant(merchant, amountTokens, ref?)` | Direct merchant payment (approves gateway internally). |
| `batchPayout(fundingSource, recipients[], amounts[], ref?)` | Batch payout. Returns `{ tx, receipt }`. |
| `listBatches(params?)` | Server-side paginated list. |
| `approveGateway(amountTokens)` | Approve gateway for amount (handles fee internally). |
| `getDecimals()` | Fetch token decimals on-chain. |
| `getAMHRBalance(address)` | Balance (human-readable). |
| `getAllowance(owner, spender)` | Current allowance. |
| `signTransferWithAuthorization(from, to, valueTokens, validAfterSec, validBeforeSec, nonce?, domainName?, domainVersion?)` | Sign EIP-3009 gasless transfer. `nonce` = bytes32 (auto-generated). `domainName`/`domainVersion` for USDC/KOKO. |
| `relayTransfer(params)` | Send signed auth to relay. Accepts `{ from, to, value, validAfter, validBefore, nonce, signature, ref? }`. |
| `formatAmount(wei)` / `parseAmount(tokens)` | Human ↔ wei conversion (uses auto-fetched decimals). |
| `formatAddress(addr)` | Short `0x1234…5678`. |
| `onAccountChanged(cb)` / `onChainChanged(cb)` | Listen for account/chain changes. |
| `getAddress()` / `getSigner()` / `getProvider()` / `getChainId()` / `isConnected()` | Current state getters. |
| `_parseError(err)` | Translates Ethereum errors to user-friendly English. |

---

## EIP-3009 Gasless Flow

```js
// 1. Sign off-chain (user wallet)
const auth = await pay.signTransferWithAuthorization({
  from: '0xUser',
  to: '0xMerchant',
  valueTokens: '10',
  validAfterSec: Math.floor(Date.now()/1000) - 60,
  validBeforeSec: Math.floor(Date.now()/1000) + 3600,
  // nonce auto-generated as bytes32
  // domainName: 'Amahoro', domainVersion: '1' // for AMHR
  // domainName: 'USD Coin', domainVersion: '2' // for USDC
});

// 2. Relay submits on-chain (server pays gas)
const result = await pay.relayTransfer(auth, 'ak_live_...'); // optional apiKey in config
```

For cross-chain settlement, include `ref: checkoutId` in both `signTransferWithAuthorization` and `relayTransfer` — the relay uses `relayTransferWithAuthorizationWithReference` which emits `MetadataAttached("GASLESS", ref, payer)` binding the proof to the checkout.

---

## Cross-Chain Swap Example

```js
// 1. Configure chain registry for switchChain()
const pay = createAmahoroPay({
  ethers,
  gatewayAddress: '0xCeloGateway',
  tokenAddress: '0xAMHR',
  relayUrl: 'https://yoursite.com/saas/?page=relay',
  apiKey: 'ak_live_...',
  chains: {
    42220: { chainId: 42220, name: 'Celo', rpc: 'https://forno.celo.org', nativeCurrency: { name: 'Celo', symbol: 'CELO', decimals: 18 }, explorer: 'https://explorer.celo.org/tx/' },
    1: { chainId: 1, name: 'Ethereum', rpc: 'https://eth.llamarpc.com', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: 'https://etherscan.io/tx/' }
  }
});

// 2. Switch wallet to source chain (e.g., Ethereum)
await pay.switchChain(1);

// 3. Sign USDC authorization on source chain
const auth = await pay.signTransferWithAuthorization({
  from: userAddress,
  to: '0xSourceGateway', // USDC EIP-3009 on source chain
  valueTokens: '100',
  domainName: 'USD Coin', domainVersion: '2',
  validAfterSec: Math.floor(Date.now()/1000) - 60,
  validBeforeSec: Math.floor(Date.now()/1000) + 3600,
  ref: checkoutId // binds proof to target checkout
});

// 4. Relay via your SaaS (forwards to source chain)
await pay.relayTransfer(auth);

// 5. SaaS calls settleCheckout on target chain (fronts AMHR + fee)
await pay.settleCheckout(checkoutId);
```

---

## Error Handling

```js
try {
  const { checkoutId } = await pay.createCheckout({...});
} catch (err) {
  // err.code: 'NETWORK_ERROR' | 'USER_REJECTED' | 'INSUFFICIENT_FUNDS' | 'CONTRACT_ERROR' | 'API_KEY_INVALID' | 'RATE_LIMITED'
  console.error(pay._parseError(err));
}
```

All methods calling the wallet throw `'Wallet not connected. Call connect() first.'` if `connect()` hasn't been called.

---

## License

MIT