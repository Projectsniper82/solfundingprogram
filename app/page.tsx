'use client';

import React, { useState, useEffect, useCallback } from "react";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { getBalance, sendSol, sweepSol } from "./solanaUtils";
import { buildFundingGraph, FundingGraph } from "./mixer";

const DEVNET = "https://api.devnet.solana.com";
const connection = new Connection(DEVNET, 'confirmed');

const WALLET_STORAGE_KEY = 'solanaMixerDepositWallet';

export default function HomePage() {
    const [depositWallet, setDepositWallet] = useState<Keypair | null>(null);
    const [depositBalance, setDepositBalance] = useState<number>(0);

    const [tradingWallets, setTradingWallets] = useState<string[]>(["", "", "", "", "", ""]);
    const [minDeposit, setMinDeposit] = useState<number>(0.1);
    
    // NEW: State for user-configurable time
    const [mixMinutes, setMixMinutes] = useState<number>(5); 
    
    const [plan, setPlan] = useState<FundingGraph | null>(null);
    const [log, setLog] = useState<string[]>([]);
    const [running, setRunning] = useState(false);
    const [waitingForDeposit, setWaitingForDeposit] = useState(false);

    useEffect(() => {
        try {
            const savedKey = localStorage.getItem(WALLET_STORAGE_KEY);
            if (savedKey) {
                const secretKey = Uint8Array.from(JSON.parse(savedKey));
                const savedWallet = Keypair.fromSecretKey(secretKey);
                setDepositWallet(savedWallet);
                setLog(l => [...l, "🔑 Loaded existing deposit wallet from storage."]);
            } else {
                const newWallet = Keypair.generate();
                localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(Array.from(newWallet.secretKey)));
                setDepositWallet(newWallet);
                setLog(l => [...l, "🔑 Created and saved a new deposit wallet."]);
            }
        } catch (error) {
            console.error("Failed to load or create wallet:", error);
            setDepositWallet(Keypair.generate());
            setLog(l => [...l, "⚠️ Could not use localStorage. Created temporary wallet."]);
        }
    }, []);

    const refreshBalance = useCallback(async () => {
        if (depositWallet) {
            const bal = await getBalance(connection, depositWallet.publicKey);
            setDepositBalance(bal);
            return bal;
        }
        return 0;
    }, [depositWallet]);

    useEffect(() => {
        if(depositWallet) {
            refreshBalance();
        }
    }, [depositWallet, refreshBalance]);


    const runMixing = useCallback(async (amountToMix: number) => {
        if (!depositWallet) {
            setLog(l => [...l, "🔴 Wallet not initialized."]);
            return;
        }
        setRunning(true);
        setLog((prevLog) => [...prevLog, "⚙️ Building mixing plan..."]);

        const recipientPKs = tradingWallets
            .map(addr => addr.trim())
            .filter(addr => addr !== '')
            .map(addr => { try { return new PublicKey(addr); } catch { return null; }})
            .filter((pk): pk is PublicKey => pk !== null);

        if (recipientPKs.length !== 6) {
            setLog((prevLog) => [...prevLog, `🔴 Error: Please provide exactly 6 valid recipient wallets. You provided ${recipientPKs.length}.`]);
            setRunning(false);
            return;
        }

        const totalSeconds = mixMinutes * 60;

        try {
            const startTime = performance.now();
            const g = await buildFundingGraph( connection, depositWallet, depositWallet.publicKey, recipientPKs, amountToMix, totalSeconds );
            setPlan(g);
            setLog((prevLog) => [...prevLog, `✅ Plan generated for a total duration of ${mixMinutes} minutes. Executing...`]);
            
            const walletMap: { [id: string]: Keypair } = {};
            g.nodes.forEach((n) => { if (n.keypair) walletMap[n.id] = n.keypair; });

            for (const step of g.edges) {
                const fromWallet = walletMap[step.from];
                const toNode = g.nodes.find((n) => n.id === step.to);
                
                if (!fromWallet || !toNode) {
                    setLog((prevLog) => [...prevLog, `🟡 Skipped: missing keypair for ${step.from}→${step.to}`]);
                    continue;
                }

                const scheduledTime = startTime + step.sendTime * 1000;
                const delay = scheduledTime - performance.now();

                if (delay > 0) {
                    setLog((prevLog) => [...prevLog, `⏳ Waiting for ${Math.round(delay / 1000)}s for next transaction.`]);
                    await new Promise(res => setTimeout(res, delay));
                }

                try {
                    setLog(l => [...l, `➡️ Sending ${step.amount.toFixed(6)} SOL from ${fromWallet.publicKey.toBase58().substring(0,4)}... to ${toNode.label} (${toNode.pubkey.toBase58().substring(0,4)}...)`]);
                    await sendSol(connection, fromWallet, toNode.pubkey, step.amount);
                    setLog((prevLog) => [...prevLog, `✅ ${step.amount.toFixed(6)} SOL transferred.`]);
                } catch (err: any) {
                    setLog((prevLog) => [...prevLog, `🔴 Transfer Error: ${err.message}. Halting.`]);
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
    }, [depositWallet, mixMinutes, tradingWallets, refreshBalance]);
    
    useEffect(() => {
        if (!waitingForDeposit || !depositWallet) return;

        const intervalId = setInterval(async () => {
            const bal = await refreshBalance();
            if (bal >= minDeposit) {
                setWaitingForDeposit(false);
                setLog((prevLog) => [...prevLog, `✅ Deposit detected: ${bal} SOL.`]);
                clearInterval(intervalId);
                setTimeout(() => runMixing(bal), 500);
            }
        }, 3000);

        return () => clearInterval(intervalId);
    }, [waitingForDeposit, depositWallet, minDeposit, runMixing, refreshBalance]);

    const handleTradingWalletChange = (index: number, value: string) => {
        const newWallets = [...tradingWallets];
        newWallets[index] = value;
        setTradingWallets(newWallets);
    };

    const handleReset = () => {
        if (!depositWallet) return;
        const warningMessage = `
            WARNING: This is a destructive action.
            This will permanently delete the secret key for the current deposit wallet from your browser's storage.
            Address: ${depositWallet.publicKey.toBase58()}
            Any funds in this wallet will be UNRECOVERABLE unless you have backed up the secret key displayed on the page.
            Are you absolutely sure you want to proceed?
        `;
        const confirmation = window.confirm(warningMessage);
        if (confirmation) {
            localStorage.removeItem(WALLET_STORAGE_KEY);
            window.location.reload();
        }
    };

const handleSweep = async () => {
    if (!plan) {
        alert("No plan available to sweep from.");
        return;
    }
    const recipientAddress = prompt("Enter the SOL address to sweep all funds to (including from the deposit wallet):");
    if (!recipientAddress) return;

    let recipientPk: PublicKey;
    try {
        recipientPk = new PublicKey(recipientAddress);
    } catch {
        alert("Invalid recipient address.");
        return;
    }

    setRunning(true);
    setLog(l => [...l, `🧹 Sweeping all funds to ${recipientAddress.substring(0,6)}...`]);
    
    // UPDATED: This filter now includes the source/deposit wallet in the sweep
    const walletsToSweep = plan.nodes
        .filter(node => node.keypair)
        .map(node => node.keypair as Keypair);

    let totalSwept = 0;
    for (const wallet of walletsToSweep) {
        try {
            const {amount, signature} = await sweepSol(connection, wallet, recipientPk);
            if (signature && amount > 0) {
                totalSwept += amount;
                const label = plan.nodes.find(n => n.keypair === wallet)?.label || 'wallet';
                setLog(l => [...l, `💸 Swept ${amount.toFixed(5)} SOL from ${label} (${wallet.publicKey.toBase58().substring(0,6)}...)`]);
            }
        } catch (error: any) {
            setLog(l => [...l, `🔴 Failed to sweep from ${wallet.publicKey.toBase58().substring(0,6)}: ${error.message}`]);
        }
    }

    setLog(l => [...l, `✅ Sweep complete. Total recovered: ${totalSwept.toFixed(5)} SOL.`]);
    setPlan(null); // Clear the plan after sweeping
    setRunning(false);
    refreshBalance();
};

    const handleCopy = () => {
        if(depositWallet) {
            navigator.clipboard.writeText(depositWallet.publicKey.toBase58());
            setLog((prevLog) => [...prevLog, "📋 Deposit address copied."]);
        }
    };

    const waitForDeposit = () => {
        setWaitingForDeposit(true);
        setLog((prevLog) => [...prevLog, `⏳ Waiting for deposit of at least ${minDeposit} SOL...`]);
    };

    if (!depositWallet) {
        return <div style={{color: 'white', textAlign: 'center', paddingTop: '50px'}}>Loading Wallet...</div>
    }

    return (
        <main style={{ maxWidth: 820, margin: "40px auto", fontFamily: "monospace", color: "#e0e0e0" }}>
            <h1>Solana Fund Mixer</h1>
            <div style={{ padding: 14, background: "#1a1a1e", borderRadius: 7, marginBottom: 16, border: '1px solid #333' }}>
                <h2>1. Deposit Funds to this Wallet</h2>
                <div>
                    <b>Address:</b> {depositWallet.publicKey.toBase58()}
                    <button onClick={handleCopy} style={{ marginLeft: 12, padding: '4px 8px', backgroundColor: '#333', borderRadius: 4 }}>Copy</button>
                    <button onClick={refreshBalance} style={{ marginLeft: 12, padding: '4px 8px', backgroundColor: '#333', borderRadius: 4 }}>Refresh Balance</button>
                </div>
                <div style={{ marginTop: 12 }}><b>Balance:</b> {depositBalance.toFixed(6)} SOL</div>
                 <div style={{ marginTop: 12, color: "#aaa", fontSize: 12, wordBreak: 'break-all' }}>
                    <b>Backup Secret Key (SAVE THIS!):</b><br />
                    [{depositWallet.secretKey.toString()}]
                </div>
            </div>

            <div style={{ padding: 14, background: "#1a1a1e", borderRadius: 7, marginBottom: 16, border: '1px solid #333' }}>
                <h2>2. Configure Recipients & Time</h2>
                 <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    {tradingWallets.map((wallet, index) => (
                        <input
                            key={index}
                            type="text"
                            placeholder={`Bot Wallet ${index + 1} Address`}
                            value={wallet}
                            onChange={(e) => handleTradingWalletChange(index, e.target.value)}
                            style={{ padding: 8, background: '#222', border: '1px solid #444', borderRadius: 4, color: '#e0e0e0', width: '100%' }}
                        />
                    ))}
                </div>
                <div style={{marginTop: '16px'}}>
                    <label>
                        <b>Total Mix Duration (minutes):</b>
                        <input
                            type="number"
                            value={mixMinutes}
                            onChange={(e) => setMixMinutes(Math.max(1, parseInt(e.target.value, 10)))}
                            min="1"
                            style={{ marginLeft: 10, padding: 8, background: '#222', border: '1px solid #444', borderRadius: 4, color: '#e0e0e0', width: '100px' }}
                        />
                    </label>
                </div>
            </div>

            <div style={{ padding: 14, background: "#1a1a1e", borderRadius: 7, marginBottom: 16, border: '1px solid #333' }}>
                <h2>3. Start Mixing</h2>
                 <button
                        onClick={waitForDeposit}
                        disabled={waitingForDeposit || running}
                        style={{ background: "#4a4a52", color: "#fff", padding: 10, borderRadius: 6, marginTop: 10, width: '100%' }}>
                        {waitingForDeposit ? `⏳ Waiting for ${minDeposit} SOL...` : "I Sent The Funds, Start Mixing!"}
                </button>
            </div>

            <div style={{ marginTop: 16 }}>
                 <button
                    onClick={handleSweep}
                    disabled={!plan || running}
                    style={{ background: "#a55229", color: "#fff", padding: 10, borderRadius: 6, marginRight: 10 }}>
                    🧹 Sweep Remaining Funds (Recovery)
                </button>
                <button
                    onClick={handleReset}
                    disabled={running}
                    style={{ background: "#8b2c2c", color: "#fff", padding: 10, borderRadius: 6 }}>
                    🔥 Reset Deposit Wallet
                </button>
            </div>
            <h2 style={{ marginTop: 16 }}>Log</h2>
            <div style={{ background: "#111", color: "#bbb", minHeight: 120, borderRadius: 7, padding: 10, maxHeight: 300, overflowY: 'auto', border: '1px solid #333', fontSize: 12 }}>
                {log.map((msg, i) => <div key={i}>{msg}</div>)}
            </div>
        </main>
    );
}