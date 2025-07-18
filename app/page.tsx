'use client';

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { getBalance, sendSol, sweepSol } from "./solanaUtils";
import { buildFundingGraph, FundingGraph, sendSplToken } from "./mixer";
import { executeSwap } from "./swap-utils";
import BN from 'bn.js';
import { getAssociatedTokenAddress } from "@solana/spl-token";

// --- Constants ---
const DEVNET = "https://api.devnet.solana.com";
const WALLET_STORAGE_KEY = 'solanaMixerDepositWallet';
const connection = new Connection(DEVNET, 'confirmed');

// --- Helper Components ---
const WalletAddress = ({ pubkey, label = "Address" }: { pubkey: PublicKey | null, label?: string }) => {
    const [copied, setCopied] = useState(false);
    if (!pubkey) return null;

    const address = pubkey.toBase58();

    const handleCopy = () => {
        navigator.clipboard.writeText(address);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="flex items-center justify-between bg-gray-800 p-3 rounded-lg mb-2">
            <span className="text-gray-400 mr-4">{label}:</span>
            <span className="truncate font-mono text-green-400">{address}</span>
            <button onClick={handleCopy} className="ml-4 px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded-md text-sm transition-colors">
                {copied ? 'Copied!' : 'Copy'}
            </button>
        </div>
    );
};

// --- Main Component ---
export default function HomePage() {
    // --- State ---
    const [depositWallet, setDepositWallet] = useState<Keypair | null>(null);
    const [depositBalance, setDepositBalance] = useState<number>(0);
    const [tradingWallets, setTradingWallets] = useState<string[]>(["", "", "", "", "", ""]);
    const [amountToMix, setAmountToMix] = useState<number>(0.1);
    const [mixMinutes, setMixMinutes] = useState<number>(1);
    const [plan, setPlan] = useState<FundingGraph | null>(null);
    const [log, setLog] = useState<string[]>([]);
    const [running, setRunning] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const logEndRef = useRef<HTMLDivElement>(null);

    // --- Effects ---

    // Scroll to bottom of logs
    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [log]);

    // Load or create deposit wallet on mount
    useEffect(() => {
        try {
            const savedKey = localStorage.getItem(WALLET_STORAGE_KEY);
            if (savedKey) {
                const secretKey = Uint8Array.from(JSON.parse(savedKey));
                const savedWallet = Keypair.fromSecretKey(secretKey);
                setDepositWallet(savedWallet);
                setLog(l => [...l, "🔑 Loaded existing deposit wallet."]);
            } else {
                const newWallet = Keypair.generate();
                localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(Array.from(newWallet.secretKey)));
                setDepositWallet(newWallet);
                setLog(l => [...l, "🔑 Created and saved a new deposit wallet."]);
            }
        } catch (error) {
            console.error("Failed to load/create wallet:", error);
            setDepositWallet(Keypair.generate()); // Temporary wallet
            setLog(l => [...l, "⚠️ Could not use localStorage. Created temporary wallet."]);
        }
    }, []);

    // Refresh balance when wallet changes
    const refreshBalance = useCallback(async () => {
        if (depositWallet) {
            try {
                const bal = await getBalance(connection, depositWallet.publicKey);
                setDepositBalance(bal);
                return bal;
            } catch (error) {
                console.error("Failed to refresh balance:", error);
                setLog(l => [...l, "🔴 Failed to fetch balance."]);
            }
        }
        return 0;
    }, [depositWallet]);

    useEffect(() => {
        if (depositWallet) {
            refreshBalance();
            const interval = setInterval(refreshBalance, 15000); // Refresh every 15s
            return () => clearInterval(interval);
        }
    }, [depositWallet, refreshBalance]);


    // --- Core Logic ---
    const runMixing = useCallback(async () => {
        if (!depositWallet) return;
        
        const currentBalance = await refreshBalance();
        if (currentBalance < amountToMix) {
            setLog(l => [...l, `🔴 Insufficient balance. Need ${amountToMix} SOL, have ${currentBalance.toFixed(4)} SOL.`]);
            return;
        }

        setRunning(true);
        setLog((prevLog) => [...prevLog, "⚙️ Building mixing plan..."]);

        const recipientPKs = tradingWallets
            .map(addr => addr.trim()).filter(addr => addr !== '')
            .map(addr => { try { return new PublicKey(addr); } catch { return null; } })
            .filter((pk): pk is PublicKey => pk !== null);

        if (recipientPKs.length === 0) {
            setLog((prevLog) => [...prevLog, `🔴 Error: Please provide at least one valid recipient wallet.`]);
            setRunning(false);
            return;
        }

        const totalSeconds = mixMinutes * 60;

        try {
            const startTime = performance.now();
            const g: FundingGraph = await buildFundingGraph(connection, depositWallet, depositWallet.publicKey, recipientPKs, amountToMix, totalSeconds);
            setPlan(g);
            
            // FIX: Use a type assertion `(g as any)` to prevent a compile error if the FundingGraph type is out of sync.
            // This is a workaround. The real fix is to ensure `totalCost: number;` exists in the FundingGraph interface in `mixer.ts`.
            const costMessage = (g as any).totalCost ? ` Total cost: ~${(g as any).totalCost.toFixed(5)} SOL.` : '';
            setLog((prevLog) => [...prevLog, `✅ Plan generated for ${mixMinutes} minutes.${costMessage} Executing...`]);

            const walletMap: { [id: string]: Keypair } = {};
            g.nodes.forEach((n) => { if (n.keypair) walletMap[n.id] = n.keypair; });
            walletMap[g.nodes[0].id] = depositWallet; // Ensure source wallet is in the map

            for (const step of g.edges) {
                const fromWallet = walletMap[step.from];
                const toNode = g.nodes.find((n) => n.id === step.to);
                if (!fromWallet || !toNode) { 
                    setLog(l => [...l, `🔴 Skipping step, wallet not found: ${step.from} -> ${step.to}`]);
                    continue; 
                }

                const scheduledTime = startTime + step.sendTime * 1000;
                const delay = scheduledTime - performance.now();

                if (delay > 0) {
                    setLog((prevLog) => [...prevLog, `⏳ Waiting for ${Math.round(delay / 1000)}s...`]);
                    await new Promise(res => setTimeout(res, delay));
                }

                try {
                    let signature: string | void | undefined;
                    switch (step.type) {
                        case 'sol-transfer':
                            setLog(l => [...l, `➡️ Transferring ${step.amount.toFixed(5)} SOL from ${step.from} to ${step.to}`]);
                            signature = await sendSol(connection, fromWallet, toNode.pubkey, step.amount);
                            setLog(l => [...l, `✅ SOL transferred. Sig: ${signature?.substring(0, 12)}...`]);
                            break;
                        
                        case 'swap':
                             // This section is complex and requires careful handling of BN
                            setLog(l => [...l, `🔄 Swapping on Raydium...`]);
                            let amountIn = new BN(step.amountInLamports?.toString() ?? '0');
                            if (amountIn.isZero()) {
                                setLog(l => [...l, `🟡 Skipping swap, no input amount.`]);
                                break;
                            }
                            signature = await executeSwap(connection, fromWallet, step.poolId!, step.inputMint!, amountIn);
                            setLog(l => [...l, `✅ Swap successful. Sig: ${signature?.substring(0,12)}...`]);
                            break;

                        case 'token-transfer':
                            setLog(l => [...l, `➡️ Transferring SPL Token from ${step.from} to ${step.to}`]);
                            signature = await sendSplToken(connection, fromWallet, toNode.pubkey, new PublicKey(step.tokenMint!));
                            setLog(l => [...l, `✅ SPL Token transferred. Sig: ${signature?.substring(0,12)}...`]);
                            break;
                    }
                } catch (err: any) {
                    console.error("Error in step:", step, err);
                    setLog((prevLog) => [...prevLog, `🔴 Step failed: ${err.message}. Halting.`]);
                    setRunning(false);
                    return;
                }
            }
            setLog((prevLog) => [...prevLog, "🎉 All mixing complete."]);
        } catch (error: any) {
            setLog((prevLog) => [...prevLog, `🔴 Critical Error building plan: ${error.message}`]);
        } finally {
            setRunning(false);
            refreshBalance();
        }
    }, [depositWallet, mixMinutes, tradingWallets, amountToMix, refreshBalance]);

    // --- Handlers ---
    const handleReset = () => {
        localStorage.removeItem(WALLET_STORAGE_KEY);
        window.location.reload();
    };

    const handleSweep = async () => {
        if (!plan && !depositWallet) {
            setLog(l => [...l, "🔴 No plan or deposit wallet available to sweep from."]);
            return;
        }

        const recipientAddress = window.prompt("Enter the SOL address to sweep all funds to:");
        if (!recipientAddress) return;

        let recipientPk: PublicKey;
        try {
            recipientPk = new PublicKey(recipientAddress);
        } catch {
            setLog(l => [...l, "🔴 Invalid recipient address."]);
            return;
        }

        setRunning(true);
        setLog(l => [...l, `🧹 Sweeping all funds to ${recipientAddress.substring(0, 6)}...`]);

        const walletsToSweep: Keypair[] = [];
        if (plan) {
            walletsToSweep.push(...plan.nodes.filter(node => node.keypair).map(node => node.keypair as Keypair));
        }
        if (depositWallet && !walletsToSweep.find(w => w.publicKey.equals(depositWallet.publicKey))) {
            walletsToSweep.push(depositWallet);
        }

        let totalSwept = 0;
        for (const wallet of walletsToSweep) {
            try {
                const { amount, signature } = await sweepSol(connection, wallet, recipientPk);
                if (signature.startsWith('sk') && amount > 0) { // Check for real signature
                    totalSwept += amount;
                    const label = plan?.nodes.find(n => n.keypair?.publicKey.equals(wallet.publicKey))?.label || 'deposit wallet';
                    setLog(l => [...l, `💸 Swept ${amount.toFixed(5)} SOL from ${label} (${wallet.publicKey.toBase58().substring(0, 6)}...)`]);
                }
            } catch (error: any) {
                setLog(l => [...l, `🔴 Failed to sweep from ${wallet.publicKey.toBase58().substring(0, 6)}: ${error.message}`]);
            }
        }

        setLog(l => [...l, `✅ Sweep complete. Total recovered: ${totalSwept.toFixed(5)} SOL.`]);
        setPlan(null);
        setRunning(false);
        refreshBalance();
    };
    
    const handleTradingWalletChange = (index: number, value: string) => {
        const newWallets = [...tradingWallets];
        newWallets[index] = value;
        setTradingWallets(newWallets);
    };

    // --- Render Loading State ---
    if (!depositWallet) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-gray-900 text-white font-mono">
                Loading Wallet...
            </div>
        );
    }

    // --- Render Main UI ---
    return (
        <main className="max-w-4xl mx-auto p-4 sm:p-6 lg:p-8 font-mono bg-gray-900 text-gray-200 min-h-screen">
            <h1 className="text-3xl font-bold text-center mb-2 text-green-400">Solana Fund Obfuscator</h1>
            <p className="text-center text-gray-500 mb-8">Distribute SOL to multiple wallets through a randomized, multi-layered process.</p>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Left Column: Config */}
                <div className="bg-gray-800 p-6 rounded-lg shadow-lg">
                    <h2 className="text-xl font-bold mb-4 border-b border-gray-700 pb-2">1. Deposit & Configuration</h2>
                    
                    <div className="mb-4">
                        <WalletAddress pubkey={depositWallet.publicKey} label="Deposit Address" />
                        <div className="text-right text-lg font-bold text-green-300">
                            Balance: {depositBalance.toFixed(5)} SOL
                        </div>
                    </div>
                    
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-bold mb-2">Amount to Mix (SOL)</label>
                            <input 
                                type="number"
                                value={amountToMix}
                                onChange={(e) => setAmountToMix(parseFloat(e.target.value))}
                                className="w-full p-2 bg-gray-900 border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                                disabled={running}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-bold mb-2">Mix Duration (Minutes)</label>
                            <input 
                                type="number"
                                value={mixMinutes}
                                onChange={(e) => setMixMinutes(parseInt(e.target.value, 10))}
                                className="w-full p-2 bg-gray-900 border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                                disabled={running}
                            />
                        </div>
                    </div>

                    <h3 className="text-lg font-bold mt-6 mb-2">2. Recipient Wallets</h3>
                    <div className="space-y-2">
                        {tradingWallets.map((wallet, index) => (
                            <input 
                                key={index}
                                type="text"
                                placeholder={`Recipient Wallet ${index + 1}`}
                                value={wallet}
                                onChange={(e) => handleTradingWalletChange(index, e.target.value)}
                                className="w-full p-2 bg-gray-900 border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 font-mono text-sm"
                                disabled={running}
                            />
                        ))}
                    </div>
                </div>

                {/* Right Column: Logs & Actions */}
                <div className="flex flex-col">
                    <div className="bg-gray-800 p-6 rounded-lg shadow-lg flex-grow flex flex-col">
                        <h2 className="text-xl font-bold mb-4 border-b border-gray-700 pb-2">3. Live Log</h2>
                        <div className="bg-black p-4 rounded-md flex-grow h-96 overflow-y-auto text-sm">
                            {log.map((entry, i) => <div key={i}>{entry}</div>)}
                            <div ref={logEndRef} />
                        </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
                        <button 
                            onClick={runMixing} 
                            disabled={running}
                            className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-4 rounded-lg transition-colors disabled:bg-gray-600 disabled:cursor-not-allowed">
                            {running ? 'Mixing...' : 'Start Mixing'}
                        </button>
                        <button 
                            onClick={handleSweep} 
                            disabled={running}
                            className="w-full bg-yellow-600 hover:bg-yellow-700 text-white font-bold py-3 px-4 rounded-lg transition-colors disabled:bg-gray-600">
                            Sweep Funds
                        </button>
                        <button 
                            onClick={() => setShowResetConfirm(true)} 
                            disabled={running}
                            className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-4 rounded-lg transition-colors disabled:bg-gray-600">
                            Reset Wallet
                        </button>
                    </div>
                </div>
            </div>

            {/* Reset Confirmation Modal */}
            {showResetConfirm && (
                <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
                    <div className="bg-gray-800 p-8 rounded-lg shadow-2xl max-w-md text-center border border-red-500">
                        <h2 className="text-2xl font-bold text-red-500 mb-4">Warning!</h2>
                        <p className="mb-4">This will permanently delete the current deposit wallet from your browser. Any funds in it will be unrecoverable unless you have backed up the secret key.</p>
                        <div className="bg-gray-900 p-2 rounded mb-6 break-all text-xs text-yellow-400">
                            {JSON.stringify(Array.from(depositWallet.secretKey))}
                        </div>
                        <p className="mb-6">Are you sure you want to proceed?</p>
                        <div className="flex justify-center gap-4">
                            <button onClick={handleReset} className="px-6 py-2 bg-red-600 hover:bg-red-700 rounded-lg font-bold">Yes, Reset</button>
                            <button onClick={() => setShowResetConfirm(false)} className="px-6 py-2 bg-gray-600 hover:bg-gray-700 rounded-lg">Cancel</button>
                        </div>
                    </div>
                </div>
            )}
        </main>
    );
}
