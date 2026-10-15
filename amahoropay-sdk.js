export function createAmahoroPay(config) {
    const {
        ethers,
        ethereum,
        gatewayAddress,
        tokenAddress,
        gatewayAbi = MINIMAL_GATEWAY_ABI,
        tokenAbi = MINIMAL_TOKEN_ABI,
        relayUrl = '?page=relay',
        apiKey = '',
        chainIdExpected = null,
        decimals = 18,
        csrfToken = ''
    } = config || {};

    const E = _resolveEthers(ethers);

    // EIP-712 domain of the deployed Amahoro token (see Amahoro.sol):
    // name "Amahoro", version "1", verify on the token address.
    const EIP712_DOMAIN = {
        name: 'Amahoro',
        version: '1',
        chainId: chainIdExpected || null
    };
    const TRANSFER_WITH_AUTH_TYPES = {
        TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' }
        ]
    };
    const ZERO32 = '0x' + '0'.repeat(64);

    let _provider = null;
    let _signer = null;
    let _address = null;
    let _chainId = null;
    let _gateway = null;
    let _token = null;

    function _resolveEthers(injected) {
        if (injected) return injected;
        if (typeof globalThis !== 'undefined' && globalThis.ethers) return globalThis.ethers;
        throw new Error('Ethers not found. Pass an ethers instance via config.ethers.');
    }

    function _ethereum() {
        if (ethereum) return ethereum;
        if (typeof window !== 'undefined' && window.ethereum) return window.ethereum;
        if (typeof globalThis !== 'undefined' && globalThis.ethereum) return globalThis.ethereum;
        return null;
    }

    function _requireConnected() {
        if (!_provider || !_signer || !_address) {
            throw new Error('Wallet not connected. Call connect() first.');
        }
    }

    function _requireGateway() {
        _requireConnected();
        if (!/^0x[a-fA-F0-9]{40}$/.test(String(gatewayAddress || ''))) {
            throw new Error('Invalid gatewayAddress in config.');
        }
    }

    function _requireToken() {
        _requireConnected();
        if (!/^0x[a-fA-F0-9]{40}$/.test(String(tokenAddress || ''))) {
            throw new Error('Invalid tokenAddress in config.');
        }
    }

    function _parseError(err) {
        if (!err) return 'Unknown error';
        const msg = err.reason || (err.data && err.data.message) || err.message || String(err);
        const friendly = {
            'user rejected the request.': 'Transaction rejected by the user.',
            'insufficient funds': 'Insufficient funds for this transaction.',
            'nonce too low': 'Nonce too low. Please retry.',
            'replacement fee too low': 'Replacement fee too low.',
            'already known': 'Transaction already in progress.',
            'bad address': 'Invalid address.',
            'checkout not found': 'Checkout not found.',
            'checkout expired': 'Checkout expired.',
            'checkout already paid': 'Checkout already paid.',
            'escrow window': 'Invalid escrow window for this action.'
        };
        const lower = msg.toLowerCase();
        for (const key of Object.keys(friendly)) {
            if (lower.indexOf(key) !== -1) return friendly[key];
        }
        return msg;
    }

    function _send(contract, method, args) {
        return args && args.length > 0
            ? contract[method](...args)
            : contract[method]();
    }

    async function _wait(tx) {
        return tx.wait();
    }

    function _getExplorerBase() {
        const explorers = {
            1: 'https://etherscan.io/tx/',
            11155111: 'https://sepolia.etherscan.io/tx/',
            137: 'https://polygonscan.com/tx/',
            80001: 'https://mumbai.polygonscan.com/tx/',
            42161: 'https://arbiscan.io/tx/',
            421614: 'https://sepolia.arbiscan.io/tx/',
            42220: 'https://explorer.celo.org/tx/',
            31337: ''
        };
        return explorers[_chainId] || 'https://etherscan.io/tx/';
    }

    async function connect(providerOverride) {
        const eth = providerOverride || _ethereum();
        if (!eth) {
            throw new Error('Wallet not detected. Install MetaMask or pass an EIP-1193 provider via config.ethereum or connect(provider).');
        }

        _provider = new E.BrowserProvider(eth);
        const accounts = await _provider.send('eth_requestAccounts', []);
        _signer = await _provider.getSigner();
        _address = accounts[0];
        _chainId = Number((await _provider.getNetwork()).chainId);
        EIP712_DOMAIN.chainId = _chainId;

        // Fetch actual token decimals on-chain (overrides config default)
        try {
            const tokenContract = getTokenContract(_provider);
            decimals = Number(await tokenContract.decimals());
        } catch (e) {
            // Fallback to config default if token call fails
        }

        _gateway = null;
        _token = null;

        return { address: _address, chainId: _chainId, provider: _provider, signer: _signer };
    }

    function ensureChain() {
        _requireConnected();
        if (chainIdExpected && Number(chainIdExpected) !== _chainId) {
            throw new Error(
                `Wrong network. Expected chain ID: ${chainIdExpected}, current: ${_chainId}. Call switchChain() first.`
            );
        }
        return _chainId;
    }

    // Cross-chain helper (T3): switches the wallet (EIP-3085 add / EIP-3326
    // switch) to the given chain. `chain` may be a full descriptor
    // { chainId, name, rpc, nativeCurrency, explorer } or a chain id looked up
    // in config.chains (registry-driven). Returns the resulting chain id.
    async function switchChain(chain) {
        const eth = _ethereum();
        if (!eth || typeof eth.request !== 'function') {
            throw new Error('Wallet not detected or not EIP-1193 compatible.');
        }

        let target;
        let descriptor;
        const registry = (config && typeof config === 'object' && config.chains) ? config.chains : null;
        if (typeof chain === 'object' && chain !== null) {
            target = Number(chain.chainId || chainIdExpected);
            descriptor = chain;
        } else {
            target = Number(chain || chainIdExpected);
        }
        if (!target) {
            throw new Error('No target chain specified. Pass { chainId } or a registry key.');
        }
        if (!descriptor && registry && registry[target]) {
            descriptor = registry[target];
        }

        const params = [{ chainId: '0x' + target.toString(16) }];
        try {
            await eth.request({ method: 'wallet_switchEthereumChain', params });
        } catch (err) {
            if (err && (err.code === 4902 || (err.data && err.data.originalError && err.data.originalError.code === 4902))) {
                if (!descriptor || !descriptor.rpc) {
                    throw new Error('Chain not in the wallet and no RPC descriptor provided to add it.');
                }
                await eth.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: '0x' + target.toString(16),
                        chainName: descriptor.name || ('Chain ' + target),
                        rpcUrls: [descriptor.rpc],
                        nativeCurrency: descriptor.nativeCurrency || { name: 'Chain', symbol: 'ETH', decimals: 18 },
                        blockExplorerUrls: descriptor.explorer ? [descriptor.explorer] : []
                    }]
                });
                await eth.request({ method: 'wallet_switchEthereumChain', params });
            } else {
                throw err;
            }
        }

        if (_provider) {
            const net = await _provider.getNetwork();
            _chainId = Number(net.chainId);
            EIP712_DOMAIN.chainId = _chainId;
            _gateway = null;
            _token = null;
        }

        return _chainId;
    }

    function getGatewayContract(providerOrSigner) {
        _requireGateway();
        const signer = providerOrSigner || _signer || _provider;
        return new E.Contract(gatewayAddress, gatewayAbi, signer);
    }

    function getTokenContract(providerOrSigner) {
        _requireToken();
        const signer = providerOrSigner || _signer || _provider;
        return new E.Contract(tokenAddress, tokenAbi, signer);
    }

    function _freshGateway() {
        _gateway = getGatewayContract();
        return _gateway;
    }

    function _toSeconds(value) {
        return typeof value === 'number'
            ? value
            : Math.floor(new Date(value).getTime() / 1000);
    }

    function _randomBytes32() {
        try {
            if (E.randomBytes) return E.hexlify(E.randomBytes(32));
        } catch (e) { /* fallthrough */ }
        let hex = '';
        const arr = new Uint8Array(32);
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(arr);
        } else {
            for (let i = 0; i < 32; i++) arr[i] = Math.floor(Math.random() * 256);
        }
        arr.forEach((b) => { hex += b.toString(16).padStart(2, '0'); });
        return '0x' + hex;
    }

    async function getAMHRBalance(address) {
        _requireConnected();
        _requireToken();
        const token = getTokenContract();
        const addr = address || _address;
        const balance = await token.balanceOf(addr);
        return E.formatUnits(balance, decimals);
    }

    async function getAllowance(owner, spender) {
        _requireConnected();
        _requireToken();
        const token = getTokenContract();
        return token.allowance(owner, spender);
    }

    async function getDecimals() {
        _requireToken();
        const token = getTokenContract(_provider);
        return Number(await token.decimals());
    }

    async function approveGateway(amountTokens) {
        _requireConnected();
        _requireToken();
        const weiAmount = E.parseUnits(String(amountTokens), decimals);
        const token = getTokenContract();
        const tx = await _send(token, 'approve', [gatewayAddress, weiAmount]);
        return { tx, receipt: await _wait(tx) };
    }

    // ── Checkout: reserved payment with guaranteed price ────────────────
    // The contract checks that `merchant` is a registered merchant; the
    // payer then signs payCheckout(checkoutId, ref) (transferFrom).
    async function createCheckout(payer, merchant, amountTokens, expiry) {
        _requireConnected();
        const gateway = _freshGateway();
        const weiAmount = E.parseUnits(String(amountTokens), decimals);

        const tx = await _send(gateway, 'createCheckout', [payer, merchant, weiAmount, _toSeconds(expiry)]);
        const receipt = await _wait(tx);

        const checkoutId = _parseId(receipt, gateway, 'CheckoutCreated', 'checkoutId');
        return { tx, receipt, checkoutId };
    }

    async function payCheckout(checkoutId, ref) {
        _requireConnected();
        const gateway = _freshGateway();
        const tx = await _send(gateway, 'payCheckout', [checkoutId, ref || ZERO32]);
        return { tx, receipt: await _wait(tx) };
    }

    async function cancelCheckout(checkoutId) {
        _requireConnected();
        const gateway = _freshGateway();
        const tx = await _send(gateway, 'cancelCheckout', [checkoutId]);
        return { tx, receipt: await _wait(tx) };
    }

    async function getCheckout(checkoutId) {
        _requireGateway();
        const gateway = getGatewayContract();
        const c = await gateway.checkouts(checkoutId);
        return {
            payer: c[0], merchant: c[1],
            amount: E.formatUnits(c[2], decimals),
            fee: E.formatUnits(c[3], decimals),
            expiresAt: Number(c[4]),
            paid: c[5], cancelled: c[6]
        };
    }

    // ── Escrow: third party holding with time windows ───────────────────
    // releaseDelay: seconds before the merchant can release;
    // expiresDelay: seconds after which the payer can refund themselves.
    async function createEscrow(merchant, amountTokens, ref, releaseDelaySec, expiresDelaySec) {
        _requireConnected();
        const gateway = _freshGateway();
        const weiAmount = E.parseUnits(String(amountTokens), decimals);

        const tx = await _send(gateway, 'createEscrow', [
            _address, merchant, weiAmount, ref || ZERO32,
            Math.floor(releaseDelaySec), Math.floor(expiresDelaySec)
        ]);
        const receipt = await _wait(tx);

        const escrowId = _parseId(receipt, gateway, 'EscrowCreated', 'escrowId');
        return { tx, receipt, escrowId };
    }

    async function depositEscrow(escrowId) {
        _requireConnected();
        _requireToken();
        const gateway = _freshGateway();
        const escrow = await gateway.escrows(escrowId);

        const token = getTokenContract();
        const allowance = await token.allowance(_address, gatewayAddress);
        if (allowance < (escrow.amount + escrow.fee)) {
            const approveTx = await _send(token, 'approve', [gatewayAddress, escrow.amount + escrow.fee]);
            await _wait(approveTx);
        }

        const tx = await _send(gateway, 'depositEscrow', [escrowId]);
        return { tx, receipt: await _wait(tx) };
    }

    async function releaseEscrow(escrowId) {
        _requireConnected();
        const gateway = _freshGateway();
        const tx = await _send(gateway, 'releaseEscrow', [escrowId]);
        return { tx, receipt: await _wait(tx) };
    }

    async function refundEscrow(escrowId) {
        _requireConnected();
        const gateway = _freshGateway();
        const tx = await _send(gateway, 'refundEscrow', [escrowId]);
        return { tx, receipt: await _wait(tx) };
    }

    async function sweepExpiredEscrow(escrowId) {
        _requireConnected();
        const gateway = _freshGateway();
        const tx = await _send(gateway, 'sweepExpiredEscrow', [escrowId]);
        return { tx, receipt: await _wait(tx) };
    }

    async function getEscrow(escrowId) {
        _requireGateway();
        const gateway = getGatewayContract();
        const e = await gateway.escrows(escrowId);
        return {
            payer: e[0], merchant: e[1],
            amount: E.formatUnits(e[2], decimals),
            fee: E.formatUnits(e[3], decimals),
            ref: e[4],
            releaseAt: Number(e[5]),
            expiresAt: Number(e[6]),
            funded: e[7], released: e[8], refunded: e[9]
        };
    }

    // ── Paiement direct marchand (avec approbation gateway) ─────────────
    async function payMerchant(merchant, amountTokens, ref) {
        _requireConnected();
        _requireToken();
        const gateway = _freshGateway();
        const weiAmount = E.parseUnits(String(amountTokens), decimals);

        const token = getTokenContract();
        const allowance = await token.allowance(_address, gatewayAddress);
        if (allowance < weiAmount) {
            const approveTx = await _send(token, 'approve', [gatewayAddress, weiAmount]);
            await _wait(approveTx);
        }

        const method = ref ? 'payMerchantWithReference' : 'payMerchant';
        const tx = await _send(gateway, method, ref ? [merchant, weiAmount, ref] : [merchant, weiAmount]);
        return { tx, receipt: await _wait(tx) };
    }

    // ── Swap / Cross-Chain Checkout Settlement ───────────────────────────
    // Authorized swap settler fronts the locked amount + fee on behalf of payer.
    async function settleCheckout(checkoutId, ref) {
        _requireConnected();
        const gateway = _freshGateway();
        const tx = await _send(gateway, 'settleCheckout', [checkoutId, ref || ZERO32]);
        return { tx, receipt: await _wait(tx) };
    }

    // ── Batch Payouts (Merchant → Multiple Recipients) ────────────────────
    // fundingSource must approve gateway for fee AND guard for batchTotal.
    async function batchPayout(fundingSource, recipients, amounts, ref) {
        _requireConnected();
        _requireToken();
        const gateway = _freshGateway();

        const token = getTokenContract();
        const totalAmount = amounts.reduce((sum, a) => sum + a, 0);
        const fee = await gateway.quoteBatchFee(totalAmount);

        // Ensure fundingSource has approved guard for totalAmount AND gateway for fee
        // (Caller must handle approvals off-SDK or via approveGateway)
        const method = ref ? 'batchPayoutWithReference' : 'batchPayout';
        const args = ref
            ? [fundingSource, recipients, amounts, ref]
            : [fundingSource, recipients, amounts];
        const tx = await _send(gateway, method, args);
        return { tx, receipt: await _wait(tx) };
    }

    // ── EIP-3009: gasless payment via the PHP relay ─────────────────────
    // Signs an EIP-3009 TransferWithAuthorization and returns the fields to
    // submit to the relay (parsed directly by the token contract). The EIP-712
    // domain defaults to the Amahoro token ("Amahoro" v1); pass domainName /
    // domainVersion for other EIP-3009 tokens (USDC, ...).
    async function signTransferWithAuthorization(from, to, valueTokens, validAfterSec, validBeforeSec, nonce, domainName, domainVersion) {
        _requireConnected();
        _requireToken();

        from = from || _address;
        const now = Math.floor(Date.now() / 1000);
        const validAfter = typeof validAfterSec === 'number'
            ? Math.floor(validAfterSec)
            : now - 60;
        const validBefore = typeof validBeforeSec === 'number'
            ? Math.floor(validBeforeSec)
            : now + 3600;
        const value = E.parseUnits(String(valueTokens), decimals);

        // Replay-protection nonce: left to the signer (bytes32), verified
        // on-chain via authorizationState. Generated randomly if omitted.
        const nonce32 = nonce || _randomBytes32();
        if (!/^0x[a-fA-F0-9]{64}$/.test(nonce32)) {
            throw new Error('invalid nonce. Must be a hex bytes32 (0x + 64 hex).');
        }

        const domain = {
            name: domainName || 'Amahoro',
            version: domainVersion || '1',
            chainId: _chainId,
            verifyingContract: tokenAddress
        };
        const message = { from, to, value, validAfter, validBefore, nonce: nonce32 };

        const signature = await _signer.signTypedData(domain, TRANSFER_WITH_AUTH_TYPES, message);
        const sig = E.Signature.from(signature);
        const packed = E.concat([sig.r, sig.s, E.toBeHex(sig.v, 1)]);

        return {
            from, to,
            value: value.toString(),
            validAfter: validAfter.toString(),
            validBefore: validBefore.toString(),
            nonce: nonce32,
            v: sig.v, r: sig.r, s: sig.s,
            signature: packed
        };
    }

    async function relayTransfer(params) {
        _requireConnected();
        const body = {
            from: params.from,
            to: params.to,
            value: String(params.value),
            validAfter: String(params.validAfter),
            validBefore: String(params.validBefore),
            nonce: params.nonce,
            signature: params.signature
        };
        // Optional bytes32 checkout binding → relayed via
        // relayTransferWithAuthorizationWithReference (MetadataAttached proof).
        if (params.ref) body.ref = String(params.ref);

        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

        let resp;
        try {
            resp = await fetch(relayUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });
        } catch (e) {
            throw new Error('Relay unreachable: ' + e.message);
        }

        let data;
        try {
            data = await resp.json();
        } catch (e) {
            throw new Error(`Invalid relay response (HTTP ${resp.status}).`);
        }

        if (!resp.ok) {
            throw new Error(data.error || data.message || `Relay failed (HTTP ${resp.status})`);
        }
        if (data.success === false) {
            throw new Error(data.message || 'Relay refused (nonce already used?).');
        }
        return data;
    }

    function parseAmount(tokens) {
        return E.parseUnits(String(tokens), decimals);
    }

    function formatAmount(wei) {
        return E.formatUnits(String(wei), decimals);
    }

    function formatAddress(address) {
        if (!address) return '';
        return address.slice(0, 6) + '...' + address.slice(-4);
    }

    // ── List API methods (server-side paginated lists) ────────────────────
    async function listCheckouts(params = {}) {
        _requireConnected();
        const url = new URL(window.location.origin + window.location.pathname);
        url.searchParams.set('page', 'checkouts');
        url.searchParams.set('format', 'json');
        if (params.limit) url.searchParams.set('limit', params.limit);
        if (params.offset) url.searchParams.set('offset', params.offset);

        const resp = await fetch(url.toString(), {
            headers: { 'Accept': 'application/json', 'X-CSRF-Token': csrfToken }
        });
        if (!resp.ok) throw new Error('Failed to load checkouts');
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed to load checkouts');
        return data.data;
    }

    async function listEscrows(params = {}) {
        _requireConnected();
        const url = new URL(window.location.origin + window.location.pathname);
        url.searchParams.set('page', 'escrows');
        url.searchParams.set('format', 'json');
        if (params.limit) url.searchParams.set('limit', params.limit);
        if (params.offset) url.searchParams.set('offset', params.offset);

        const resp = await fetch(url.toString(), {
            headers: { 'Accept': 'application/json', 'X-CSRF-Token': csrfToken }
        });
        if (!resp.ok) throw new Error('Failed to load escrows');
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed to load escrows');
        return data.data;
    }

    async function listBatches(params = {}) {
        _requireConnected();
        const url = new URL(window.location.origin + window.location.pathname);
        url.searchParams.set('page', 'batch-payouts');
        url.searchParams.set('format', 'json');
        if (params.limit) url.searchParams.set('limit', params.limit);
        if (params.offset) url.searchParams.set('offset', params.offset);

        const resp = await fetch(url.toString(), {
            headers: { 'Accept': 'application/json', 'X-CSRF-Token': csrfToken }
        });
        if (!resp.ok) throw new Error('Failed to load batches');
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed to load batches');
        return data.data;
    }

    function onAccountChanged(callback) {
        const eth = _ethereum();
        if (!eth || typeof eth.on !== 'function') return;
        eth.on('accountsChanged', (accounts) => {
            _address = accounts[0] || null;
            _signer = null;
            _gateway = null;
            _token = null;
            if (_address && _provider) {
                _provider.getSigner().then((s) => { _signer = s; }).catch(() => {});
            }
            if (callback) callback(accounts);
        });
    }

    function onChainChanged(callback) {
        const eth = _ethereum();
        if (!eth || typeof eth.on !== 'function') return;
        eth.on('chainChanged', (chainIdHex) => {
            _chainId = parseInt(chainIdHex, 16);
            EIP712_DOMAIN.chainId = _chainId;
            _gateway = null;
            _token = null;
            if (callback) callback(_chainId);
        });
    }

    function getAddress() { return _address; }
    function getChainId() { return _chainId; }
    function getSigner() { return _signer; }
    function getProvider() { return _provider; }
    function isConnected() { return !!_address; }
    function getConfig() {
        return { gatewayAddress, tokenAddress, relayUrl, chainIdExpected, decimals, hasApiKey: !!apiKey };
    }

    return {
        connect,
        ensureChain,
        switchChain,
        getGatewayContract,
        getTokenContract,

        createCheckout,
        payCheckout,
        settleCheckout,
        cancelCheckout,
        getCheckout,
        listCheckouts,

        createEscrow,
        depositEscrow,
        releaseEscrow,
        refundEscrow,
        sweepExpiredEscrow,
        getEscrow,
        listEscrows,

        payMerchant,
        batchPayout,
        listBatches,

        signTransferWithAuthorization,
        relayTransfer,

        approveGateway,
        getAMHRBalance,
        getAllowance,
        getDecimals,

        parseAmount,
        formatAmount,
        formatAddress,
        getExplorerBase: _getExplorerBase,

        onAccountChanged,
        onChainChanged,

        getAddress,
        getChainId,
        getSigner,
        getProvider,
        isConnected,
        getConfig,

        _parseError
    };
}

const MINIMAL_GATEWAY_ABI = [
    // ── Checkout ─────────────────────────────────────────────────────────
    'function createCheckout(address payer, address merchant, uint256 amount, uint256 expiresAt) returns (bytes32 checkoutId)',
    'function payCheckout(bytes32 checkoutId, bytes32 ref)',
    'function settleCheckout(bytes32 checkoutId, bytes32 ref)',
    'function cancelCheckout(bytes32 checkoutId)',
    'function checkouts(bytes32) view returns (address payer, address merchant, uint256 amount, uint256 fee, uint256 expiresAt, bool paid, bool cancelled)',

    // ── Escrow ───────────────────────────────────────────────────────────
    'function createEscrow(address payer, address merchant, uint256 amount, bytes32 ref, uint256 releaseDelay, uint256 expiresDelay) returns (bytes32 escrowId)',
    'function escrows(bytes32) view returns (address payer, address merchant, uint256 amount, uint256 fee, bytes32 ref, uint256 releaseAt, uint256 expiresAt, bool funded, bool released, bool refunded)',
    'function depositEscrow(bytes32 escrowId)',
    'function releaseEscrow(bytes32 escrowId)',
    'function refundEscrow(bytes32 escrowId)',
    'function sweepExpiredEscrow(bytes32 escrowId)',

    // ── Direct Payments ──────────────────────────────────────────────────
    'function payMerchant(address merchant, uint256 amount) returns (uint256 fee)',
    'function payMerchantWithReference(address merchant, uint256 amount, bytes32 ref) returns (uint256 fee)',

    // ── Batch Payouts ────────────────────────────────────────────────────
    'function batchPayout(address fundingSource, address[] recipients, uint256[] amounts) returns (uint256 fee)',
    'function batchPayoutWithReference(address fundingSource, address[] recipients, uint256[] amounts, bytes32 ref) returns (uint256 fee)',

    // ── Gasless / EIP-3009 ───────────────────────────────────────────────
    'function relayTransferWithAuthorization(address from, address to, uint256 value, uint256 vAfter, uint256 vBefore, bytes32 nonce, bytes signature) returns (uint256 count)',
    'function relayTransferWithAuthorizationWithReference(address from, address to, uint256 value, uint256 vAfter, uint256 vBefore, bytes32 nonce, bytes signature, bytes32 ref) returns (uint256 count)',

    // ── View Functions ───────────────────────────────────────────────────
    'function clientEffectiveLimit(address client) view returns (uint256)',
    'function clientQuota(address client) view returns (uint8 tier, uint256 limit, uint256 spentToday, uint64 lastReset)',
    'function clientVolume(address client) view returns (uint256)',
    'function subscriptionActive(address client) view returns (bool)',
    'function quoteMerchantFee(uint256 amount) view returns (uint256)',
    'function quoteBatchFee(uint256 batchTotal) view returns (uint256)',
    'function quoteGaslessFee(uint256 amount) view returns (uint256)',
    'function toWei(uint256 tokens) view returns (uint256)',
    'function fromWei(uint256 weiAmount) view returns (uint256)',

    // ── Events ───────────────────────────────────────────────────────────
    'event CheckoutCreated(bytes32 indexed checkoutId, address indexed payer, address indexed merchant, uint256 amount, uint256 fee, uint256 expiresAt)',
    'event CheckoutPaid(bytes32 indexed checkoutId, address indexed payer, address indexed merchant, uint256 amount, uint256 fee, bytes32 ref)',
    'event CheckoutCancelled(bytes32 indexed checkoutId)',
    'event EscrowCreated(bytes32 indexed escrowId, address indexed payer, address indexed merchant, uint256 amount, uint256 fee, bytes32 ref, uint256 releaseAt, uint256 expiresAt)',
    'event EscrowFunded(bytes32 indexed escrowId, address indexed funder, uint256 amount)',
    'event EscrowReleased(bytes32 indexed escrowId, address indexed merchant, uint256 amount)',
    'event EscrowRefunded(bytes32 indexed escrowId, address indexed payer, uint256 amount)',
    'event EscrowSwept(bytes32 indexed escrowId, address indexed sweeper, uint256 amount)',
    'event MerchantPayout(address indexed payer, address indexed merchant, uint256 amount, uint256 fee)',
    'event BatchPayoutRouted(address indexed fundingSource, uint256 batchTotal, uint256 fee)',
    'event TransferRelayed(address indexed relayer, address indexed from, address indexed to, uint256 value, bytes32 nonce)',
    'event FeeCollected(uint8 indexed category, address indexed payer, uint256 amount)',
    'event FeesWithdrawn(address indexed feeRecipient, uint256 amount)',
    'event MetadataAttached(uint8 indexed category, bytes32 indexed ref, address indexed payer)',
    'event VolumeUpdated(address indexed client, uint256 totalVolume)',
    'event SubscriptionUpdated(address indexed client, uint256 expiresAt)',
    'event EnterpriseWalletSet(address indexed wallet, bytes32 enterpriseId)'
];

const MINIMAL_TOKEN_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function authorizationState(address, bytes32) view returns (bool)',
    'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)'
];

function _parseId(receipt, gateway, eventName, argName) {
    for (const log of receipt.logs) {
        try {
            const parsed = gateway.interface.parseLog(log);
            if (parsed && parsed.name === eventName && parsed.args[argName]) {
                return parsed.args[argName];
            }
        } catch (e) {
            /* ignore */
        }
    }
    return null;
}