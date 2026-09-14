# amahoropay-sdk

Module ES unique et sans dépendance framework pour intégrer les paiements **AMHR** (contrat `AmahoroGateway.sol`).

Fonctionne tel quel en **Vanilla JS**, **React**, **Next.js** et **React Native** : une seule source de vérité pour tout le Web3 (connexion wallet, checkout, escrow, relay gasless EIP-3009, formats AMHR).

## Installation

### Vanilla JS (via CDN)

```html
<script src="https://cdn.jsdelivr.net/npm/ethers@6.9.0/dist/ethers.umd.min.js"></script>
<script type="module">
    import { createAmahoroPay } from 'https://cdn.jsdelivr.net/gh/divinrule/amahoropay-sdk@main/amahoropay-sdk.js';
    const pay = createAmahoroPay({ ethers, gatewayAddress: '0x...', tokenAddress: '0x...' });
</script>
```

Version figée en production : remplacez `@main` par `@v1.1.0`. Autres règles : `@v1` = dernière du majeur, `@main` = dernier push (cache court).

### React / Next.js / React Native

Copiez `amahoropay-sdk.js` dans votre projet (`src/lib/amahoropay-sdk.js`) puis :

```js
import { createAmahoroPay } from '../lib/amahoropay-sdk';
```

React Native : le wallet (WalletConnect, MetaMask SDK mobile) fournit un provider EIP-1193. Injectez-le via `sdk.connect(provider)` au moment de la connexion.

## Configuration

```js
const pay = createAmahoroPay({
    ethers,                                 // instance ethers (globale UMD ou `import { ethers } from 'ethers'`)
    ethereum,                               // optionnel : provider EIP-1193 injecté (MetaMask ou WalletConnect)
    gatewayAddress: '0x…',                  // adresse du contrat AmahoroGateway
    tokenAddress:   '0x…',                  // adresse du token AMHR
    gatewayAbi:     undefined,              // optionnel : ABI custom (sinon ABI minimale embarquée)
    tokenAbi:       undefined,              // optionnel : ABI custom
    relayUrl:       'https://…/index.php?page=relay',  // endpoint relay gasless
    apiKey:         '',                     // clé API pour le relay
    chainIdExpected: null,                  // optionnel : vérifie le réseau après connexion
    decimals:       18                      // décimales du token AMHR
});
```

## API

| Méthode | Description |
|---|---|
| `connect(providerOverride?)` | Connexion wallet : sans arg = MetaMask (`window.ethereum`), avec arg = provider EIP-1193 injecté (RN/WalletConnect). Retourne `{ provider, signer, address }` |
| `ensureChain()` | Vérifie `chainIdExpected` (throw si mauvais réseau) |
| `createCheckout(payer, amountTokens, expiry)` | Crée un checkout (payer = bénéficiaire) |
| `payCheckout(checkoutId)` | Paye un checkout |
| `cancelCheckout(checkoutId)` | Annule un checkout |
| `getCheckout(checkoutId)` | Consulte un checkout |
| `createEscrow(recipient, amountTokens, fundDeadline, releaseWindow)` | Crée un escrow |
| `depositEscrow(escrowId)` / `releaseEscrow(escrowId)` / `refundEscrow(escrowId)` | Cycle escrow |
| `getEscrow(escrowId)` | Consulte un escrow |
| `approveGateway(amountTokens)` | Approuve le gateway sur vos tokens |
| `getAMHRBalance(address)` | Solde AMHR (chaîne lisible) |
| `getAllowance(owner, spender)` | Allowance actuelle |
| `signTransferWithAuthorization(from, to, valueTokens, validAfterSec, validBeforeSec)` | Signe un transfert gasless EIP-3009 |
| `relayTransfer(params)` | Envoie la signature au relayer (`{from, to, value, deadline, signature}` + `apiKey`) |
| `formatAmount(wei)` / `parseAmount(tokens)` | Conversion 10^decimals ↔ lisible |
| `formatAddress(addr)` | Adresse raccourcie `0x1234…5678` |
| `onAccountChanged(cb)` / `onChainChanged(cb)` | Écoute les changements de compte / réseau |
| `getAddress()` / `getSigner()` / `getProvider()` / `getChainId()` / `isConnected()` | État courant |
| `_parseError(err)` | Traduit les erreurs Ethereum en français |

Les fonctions appelant le wallet throwent `'Wallet non connecté. Appelez d\'abord connect().'` si `connect()` n'a pas été fait.

## Licence

MIT