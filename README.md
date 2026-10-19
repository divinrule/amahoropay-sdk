# AmahoroPay SDK

JavaScript/TypeScript SDK for integrating AmahoroPay crypto payments into your application.

## Features

- **Checkout Payments**: Create and manage payment checkouts with QR codes
- **Escrow**: Create escrows with configurable release/expiry windows
- **Direct Merchant Payments**: Direct token transfers with automatic fee handling
- **Batch Payouts**: Send tokens to multiple recipients in a single transaction
- **Gasless Relay (EIP-3009)**: Users sign authorizations, relayer pays gas
- **Cross-Chain Swaps**: Accept payments on any EVM chain, settle on Celo
- **Auto-config from Backend**: Fetch gateway/token addresses from your backend

## Installation

### CDN (Browser)
```html
<script src="https://cdn.jsdelivr.net/npm/ethers@6.9.0/dist/ethers.umd.min.js"></script>
<script type="module">
  import { createAmahoroPay, createAmahoroPayAsync } from 'https://cdn.jsdelivr.net/gh/divinrule/amahoropay-sdk@main/amahoropay-sdk.js';
</script>
```

### NPM (Node.js/React/Next.js)
```bash
npm install amahoropay-sdk
```

```js
import { createAmahoroPay, createAmahoroPayAsync } from 'amahoropay-sdk';
```

## Quick Start

### Recommended: Auto-config from Backend (v2.0+)

```js
import { createAmahoroPayAsync } from 'amahoropay-sdk';

const pay = await createAmahoroPayAsync({
  configUrl: 'https://yourdomain.com/?page=api-config',
  ethers,
  ethereum,
  apiKey: 'ak_your_key',        // optional, for authenticated endpoints
  csrfToken: '...'              // optional, for CSRF protection
});

// Now gateway/token are auto-fetched from your backend
const { checkoutId } = await pay.createCheckout({
  payer: '0x0000000000000000000000000000000000000000',
  merchant: '0xYourWallet',
  amount: '10',
  expiresAt: Math.floor(Date.now()/1000) + 3600
});
```

### Legacy: Manual Config

```js
const pay = createAmahoroPay({
  ethers,
  gatewayAddress: '0xYourGateway',
  tokenAddress: '0xYourToken',
  chainIdExpected: 31337,
  relayUrl: 'https://yourdomain.com/?page=relay',
  apiKey: 'ak_your_key'
});
```

## Core Methods

### Checkout
```js
// Create checkout
const { checkoutId } = await pay.createCheckout({
  payer: '0x...',           // payer address (zero = anyone)
  merchant: '0x...',        // merchant wallet
  amount: '10',             // amount in tokens (human-readable)
  expiresAt: 1735686000     // unix timestamp
});

// Payer pays
const { receipt } = await pay.payCheckout(checkoutId);

// Cancel
await pay.cancelCheckout(checkoutId);

// Get details
const checkout = await pay.getCheckout(checkoutId);
```

### Escrow
```js
// Create escrow
const { escrowId } = await pay.createEscrow({
  merchant: '0x...',
  amount: '5',
  ref: '0x...',
  releaseDelaySec: 3600,    // before merchant can release
  expiresDelaySec: 7200     // before payer can refund
});

// Payer deposits (auto-approves)
await pay.depositEscrow(escrowId);

// Merchant releases
await pay.releaseEscrow(escrowId);

// Payer refunds (after expiry)
await pay.refundEscrow(escrowId);
```

### Direct Merchant Payment
```js
const { receipt } = await pay.payMerchant({
  merchant: '0x...',
  amount: '10',
  ref: '0x...' // optional
});
```

### Batch Payouts
```js
const { receipt } = await pay.batchPayout({
  fundingSource: '0x...',
  recipients: ['0xAddr1', '0xAddr2'],
  amounts: ['10', '20'],    // human-readable amounts
  ref: '0x...'              // optional
});
```

### Gasless Relay (EIP-3009)
```js
// Sign authorization
const auth = await pay.signTransferWithAuthorization(
  '0xFrom', '0xTo', '1',    // from, to, value (tokens)
  Math.floor(Date.now()/1000) - 60,   // validAfter
  Math.floor(Date.now()/1000) + 3600  // validBefore
);

// Relay via your backend
const result = await pay.relayTransfer({
  ...auth,
  ref: checkoutId  // optional, for cross-chain binding
});
```

## Configuration

```js
const pay = createAmahoroPay({
  ethers,                      // ethers v6 instance
  ethereum,                    // window.ethereum or custom provider
  gatewayAddress: '0x...',     // AmahoroGateway address
  tokenAddress: '0x...',       // Token address (AMHR/USDC)
  gatewayAbi: [...],           // optional custom ABI
  tokenAbi: [...],             // optional custom token ABI
  relayUrl: '?page=relay',     // your relay endpoint
  apiKey: 'ak_...',            // for authenticated endpoints
  chainIdExpected: 42220,      // validate chain
  decimals: 18,                // token decimals
  csrfToken: '',               // CSRF token for POST requests
  // Security options
  maxFeeBps: 1000,             // max 10% fee for payMerchant
  maxBatchAmount: '1000000000000000000000000', // 1M tokens max
  requestTimeout: 30000,       // 30s timeout
  maxRetries: 2                // retry failed requests
});
```

## Auto-config Endpoint

Your backend should expose `GET /?page=api-config`:

```json
{
  "success": true,
  "data": {
    "gatewayAddress": "0xD70c1f5eB17FF1255d2056c41672171D8C06135d",
    "tokenAddress": "0x06CAe70F74847f35De1e81F83641EE1B3FAa3bfa",
    "chainIdExpected": 42220,
    "relayUrl": "https://yourdomain.com/?page=relay",
    "decimals": 18
  }
}
```

## Error Handling

All methods throw structured errors:

```js
try {
  const { checkoutId } = await pay.createCheckout({...});
} catch (err) {
  console.error(err.code, err.message);
  // Codes: WALLET_NOT_CONNECTED, INVALID_CONFIG, USER_REJECTED,
  // INSUFFICIENT_FUNDS, CONTRACT_ERROR, NETWORK_ERROR, etc.
}
```

## Security

- **Never expose API keys** in frontend code - use backend proxy
- **Validate gateway/token** on backend (SDK validates locally, backend enforces)
- **Use HTTPS** - required for MetaMask
- **CSRF protection** - include `X-CSRF-Token` header
- **Rate limiting** - SDK respects `maxRetries` and `requestTimeout`

## Requirements

- **ethers.js v6** (included via CDN or npm)
- **MetaMask** or EIP-1193 compatible wallet
- **HTTPS** (required for MetaMask)

## License

MIT