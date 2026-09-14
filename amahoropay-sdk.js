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
        decimals = 18
    } = config || {};

    const E = _resolveEthers(ethers);

    let _provider = null;
    let _signer = null;
    let _address = null;
    let _chainId = null;
    let _gateway = null;
    let _token = null;

    function _resolveEthers(injected) {
        if (injected) return injected;
        if (typeof globalThis !== 'undefined' && globalThis.ethers) return globalThis.ethers;
        throw new Error('Ethers introuvable. Passez l\'instance ethers via la config (config.ethers).');
    }

    function _ethereum() {
        if (ethereum) return ethereum;
        if (typeof window !== 'undefined' && window.ethereum) return window.ethereum;
        if (typeof globalThis !== 'undefined' && globalThis.ethereum) return globalThis.ethereum;
        return null;
    }

    function _requireConnected() {
        if (!_provider || !_signer || !_address) {
            throw new Error('Wallet non connecté. Appelez d\'abord connect().');
        }
    }

    function _requireGateway() {
        _requireConnected();
        if (!/^0x[a-fA-F0-9]{40}$/.test(String(gatewayAddress || ''))) {
            throw new Error('gatewayAddress invalide dans la config.');
        }
    }

    function _requireToken() {
        _requireConnected();
        if (!/^0x[a-fA-F0-9]{40}$/.test(String(tokenAddress || ''))) {
            throw new Error('tokenAddress invalide dans la config.');
        }
    }

    function _parseError(err) {
        if (!err) return 'Erreur inconnue';
        const msg = err.reason || (err.data && err.data.message) || err.message || String(err);
        const friendly = {
            'user rejected the request.': 'Transaction refusée par l\'utilisateur.',
            'insufficient funds': 'Fonds insuffisants pour cette transaction.',
            'nonce too low': 'Nonce trop bas. Réessayez.',
            'replacement fee too low': 'Frais de remplacement trop bas.',
            'already known': 'Transaction déjà en cours.',
            'bad address': 'Adresse invalide.'
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
            31337: ''
        };
        return explorers[_chainId] || 'https://etherscan.io/tx/';
    }

    async function connect(providerOverride) {
        const eth = providerOverride || _ethereum();
        if (!eth) {
            throw new Error('Wallet non détecté. Installez MetaMask ou passez un provider EIP-1193 via config.ethereum ou connect(provider).');
        }

        _provider = new E.BrowserProvider(eth);
        const accounts = await _provider.send('eth_requestAccounts', []);
        _signer = await _provider.getSigner();
        _address = accounts[0];
        _chainId = Number((await _provider.getNetwork()).chainId);

        _gateway = null;
        _token = null;

        return { address: _address, chainId: _chainId, provider: _provider, signer: _signer };
    }

    function ensureChain() {
        _requireConnected();
        if (chainIdExpected && Number(chainIdExpected) !== _chainId) {
            throw new Error(
                `Mauvais réseau. Chain ID attendu : ${chainIdExpected}, actuel : ${_chainId}.`
            );
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

    async function approveGateway(amountTokens) {
        _requireConnected();
        _requireToken();
        const weiAmount = E.parseUnits(String(amountTokens), decimals);
        const token = getTokenContract();
        const tx = await _send(token, 'approve', [gatewayAddress, weiAmount]);
        return { tx, receipt: await _wait(tx) };
    }

    async function createCheckout(payer, amountTokens, expiry) {
        _requireConnected();
        const gateway = _freshGateway();
        const weiAmount = E.parseUnits(String(amountTokens), decimals);
        const expirySec = typeof expiry === 'number'
            ? expiry
            : Math.floor(new Date(expiry).getTime() / 1000);

        const tx = await _send(gateway, 'createCheckout', [payer, weiAmount, expirySec]);
        const receipt = await _wait(tx);

        const checkoutId = _parseCheckoutId(receipt, gateway);
        return { tx, receipt, checkoutId };
    }

    async function payCheckout(checkoutId) {
        _requireConnected();
        const gateway = _freshGateway();
        const tx = await _send(gateway, 'payCheckout', [checkoutId]);
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
            merchant: c[0], payer: c[1],
            amount: E.formatUnits(c[2], decimals),
            expiry: Number(c[3]),
            paid: c[4], cancelled: c[5]
        };
    }

    async function createEscrow(recipient, amountTokens, fundDeadline, releaseWindow) {
        _requireConnected();
        const gateway = _freshGateway();
        const weiAmount = E.parseUnits(String(amountTokens), decimals);
        const fundSec = typeof fundDeadline === 'number'
            ? fundDeadline
            : Math.floor(new Date(fundDeadline).getTime() / 1000);
        const releaseSec = typeof releaseWindow === 'number'
            ? releaseWindow
            : Math.floor(new Date(releaseWindow).getTime() / 1000);

        const tx = await _send(gateway, 'createEscrow', [recipient, weiAmount, fundSec, releaseSec]);
        const receipt = await _wait(tx);

        const escrowId = _parseEscrowId(receipt, gateway);
        return { tx, receipt, escrowId };
    }

    async function depositEscrow(escrowId) {
        _requireConnected();
        _requireToken();
        const gateway = _freshGateway();
        const escrow = await gateway.escrows(escrowId);

        const token = getTokenContract();
        const allowance = await token.allowance(_address, gatewayAddress);
        if (allowance < escrow.amount) {
            const approveTx = await _send(token, 'approve', [gatewayAddress, escrow.amount]);
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

    async function getEscrow(escrowId) {
        _requireGateway();
        const gateway = getGatewayContract();
        const e = await gateway.escrows(escrowId);
        return {
            sender: e[0], recipient: e[1],
            amount: E.formatUnits(e[2], decimals),
            fundDeadline: Number(e[3]),
            releaseWindow: Number(e[4]),
            funded: e[5], released: e[6], refunded: e[7]
        };
    }

    async function signTransferWithAuthorization(from, to, valueTokens, validAfterSec, validBeforeSec) {
        _requireConnected();
        _requireToken();
        _requireGateway();

        const token = getTokenContract();
        const name = await token.name();
        const version = await token.version().catch(() => '1');
        const nonce = await token.nonces(from);
        const now = Math.floor(Date.now() / 1000);
        const validAfter = typeof validAfterSec === 'number' ? validAfterSec : now - 60;
        const deadline = typeof validBeforeSec === 'number' ? validBeforeSec : now + 3600;
        const value = E.parseUnits(String(valueTokens), decimals);

        const domain = { name, version, chainId: _chainId, verifyingContract: tokenAddress };
        const types = {
            TransferWithAuthorization: [
                { name: 'from', type: 'address' },
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' }
            ]
        };
        const message = { from, to, value, nonce, deadline };

        const signature = await _signer.signTypedData(domain, types, message);
        const sig = E.Signature.from(signature);

        const packed = E.concat([sig.r, sig.s, E.toBeHex(sig.v, 1)]);

        return {
            from, to,
            value: value.toString(),
            deadline,
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
            deadline: Number(params.deadline) || 0,
            signature: params.signature
        };

        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

        const resp = await fetch(relayUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });

        const data = await resp.json();
        if (!resp.ok) {
            throw new Error(data.error || data.message || `Échec du relay (HTTP ${resp.status})`);
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
        getGatewayContract,
        getTokenContract,

        createCheckout,
        payCheckout,
        cancelCheckout,
        getCheckout,

        createEscrow,
        depositEscrow,
        releaseEscrow,
        refundEscrow,
        getEscrow,

        signTransferWithAuthorization,
        relayTransfer,

        approveGateway,
        getAMHRBalance,
        getAllowance,

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
    'function createCheckout(address payer, uint256 amount, uint256 expiry) returns (bytes32 checkoutId)',
    'function payCheckout(bytes32 checkoutId)',
    'function cancelCheckout(bytes32 checkoutId)',
    'function checkouts(bytes32) view returns (address merchant, address payer, uint256 amount, uint256 expiry, bool paid, bool cancelled)',
    'function createEscrow(address recipient, uint256 amount, uint256 fundDeadline, uint256 releaseWindow) returns (uint256 escrowId)',
    'function escrows(uint256) view returns (address sender, address recipient, uint256 amount, uint256 fundDeadline, uint256 releaseWindow, bool funded, bool released, bool refunded)',
    'function depositEscrow(uint256 escrowId)',
    'function releaseEscrow(uint256 escrowId)',
    'function refundEscrow(uint256 escrowId)',
    'function sweepExpiredEscrow(uint256 escrowId)',
    'function payMerchant(address merchant, address recipient, uint256 amount, string reference)',
    'function relayTransferWithAuthorization(address from, address to, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
    'function relayTransferWithAuthorizationWithReference(address from, address to, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s, string reference)',
    'event CheckoutCreated(bytes32 indexed checkoutId, address indexed merchant, address indexed payer, uint256 amount, uint256 expiry)',
    'event CheckoutPaid(bytes32 indexed checkoutId, address indexed payer, uint256 amount)',
    'event CheckoutCancelled(bytes32 indexed checkoutId)',
    'event EscrowCreated(uint256 indexed escrowId, address indexed sender, address indexed recipient, uint256 amount, uint256 fundDeadline, uint256 releaseWindow)',
    'event EscrowFunded(uint256 indexed escrowId, address indexed funder, uint256 amount)',
    'event EscrowReleased(uint256 indexed escrowId, address indexed recipient, uint256 amount)',
    'event EscrowRefunded(uint256 indexed escrowId, address indexed sender, uint256 amount)'
];

const MINIMAL_TOKEN_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function nonces(address) view returns (uint256)',
    'function name() view returns (string)',
    'function version() view returns (string)',
    'function decimals() view returns (uint8)',
    'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)'
];

function _parseCheckoutId(receipt, gateway) {
    for (const log of receipt.logs) {
        try {
            const parsed = gateway.interface.parseLog(log);
            if (parsed && parsed.name === 'CheckoutCreated' && parsed.args.checkoutId) {
                return parsed.args.checkoutId;
            }
        } catch (e) {
            /* ignore */
        }
    }
    return null;
}

function _parseEscrowId(receipt, gateway) {
    for (const log of receipt.logs) {
        try {
            const parsed = gateway.interface.parseLog(log);
            if (parsed && parsed.name === 'EscrowCreated' && parsed.args.escrowId) {
                return parsed.args.escrowId;
            }
        } catch (e) {
            /* ignore */
        }
    }
    return null;
}