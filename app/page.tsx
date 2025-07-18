'use client';

import React, { useState, useEffect, useCallback } from "react";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { getBalance, sendSol, sweepSol } from "./solanaUtils";
import { buildFundingGraph, FundingGraph, sendSplToken } from "./mixer";
import { executeSwap } from "./swap-utils";
import BN from 'bn.js';
import { getAssociatedTokenAddress } from "@solana/spl-token";

const DEVNET = "https://api.devnet.solana.com";
const connection = new Connection(DEVNET, 'confirmed');

const WALLET_STORAGE_KEY = 'solanaMixerDepositWallet';

export default function HomePage() {
    const [depositWallet, setDepositWallet] = useState<Keypair | null>(null);
    const [depositBalance, setDepositBalance] = useState<number>(0);
    const [tradingWallets, setTradingWallets] = useState<string[]>(["", "", "", "", "", ""]);
    const [minDeposit, setMinDeposit] = useState<number>(0.1);
    const [mixMinutes, setMixMinutes] = useState<number>(1);
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
                setLog(l => [...l, "🔑 Loaded existing deposit wallet."]);
            } else {
                const newWallet = Keypair.generate();
                localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(Array.from(newWallet.secretKey)));
                setDepositWallet(newWallet);
                setLog(l => [...l, "🔑 Created and saved a new deposit wallet."]);
            }
        } catch (error) {
            console.error("Failed to load/create wallet:", error);
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
        if (!depositWallet) { return; }
        setRunning(true);
        setLog((prevLog) => [...prevLog, "⚙️ Building mixing plan with swaps..."]);

        const recipientPKs = tradingWallets
            .map(addr => addr.trim()).filter(addr => addr !== '')
            .map(addr => { try { return new PublicKey(addr); } catch { return null; }}).filter((pk): pk is PublicKey => pk !== null);

        if (recipientPKs.length === 0) {
            setLog((prevLog) => [...prevLog, `🔴 Error: Please provide at least one valid recipient wallet.`]);
            setRunning(false);
            return;
        }

        const totalSeconds = mixMinutes * 60;

        try {
            const startTime = performance.now();
            const g: FundingGraph = await buildFundingGraph( connection, depositWallet, depositWallet.publicKey, recipientPKs, amountToMix, totalSeconds );
            setPlan(g);
            setLog((prevLog) => [...prevLog, `✅ Plan generated for ${mixMinutes} minutes. Executing...`]);
            
            const walletMap: { [id: string]: Keypair } = {};
            g.nodes.forEach((n) => { if (n.keypair) walletMap[n.id] = n.keypair; });

            for (const step of g.edges) {
                const fromWallet = walletMap[step.from];
                const toNode = g.nodes.find((n) => n.id === step.to);
                if (!fromWallet || !toNode) { continue; }

                const scheduledTime = startTime + step.sendTime * 1000;
                const delay = scheduledTime - performance.now();
                if (delay > 0) {
                    setLog((prevLog) => [...prevLog, `⏳ Waiting for ${Math.round(delay / 1000)}s...`]);
                    // CORRECTED: Added type for `res`
                    await new Promise(res => setTimeout(res, delay));
                }

                try {
                    let signature: string | void | undefined;
                    switch (step.type) {
                        case 'sol-transfer':
                            setLog(l => [...l, `➡️ Transferring SOL...`]);
                            if (step.amount === 0) {
                                const result = await sweepSol(connection, fromWallet, toNode.pubkey);
                                signature = result.signature;
                            } else {
                                signature = await sendSol(connection, fromWallet, toNode.pubkey, step.amount);
                            }
                            setLog(l => [...l, `✅ SOL transferred. Sig: ${signature?.substring(0,12)}...`]);
                            break;
                        
                        case 'swap':
                            setLog(l => [...l, `🔄 Swapping ${step.inputMint?.substring(0,4)} to ${step.outputMint?.substring(0,4)}...`]);
                            let amountIn = new BN(step.amountInLamports?.toString() ?? '0');
                            
                            if (amountIn.isZero() && step.inputMint) {
                                const inputMintPk = new PublicKey(step.inputMint);
                                const ata = await getAssociatedTokenAddress(inputMintPk, fromWallet.publicKey);
                                const balance = await connection.getTokenAccountBalance(ata);
                                amountIn = new BN(balance.value.amount);
                            }

                            if(amountIn.isZero()) {
                                setLog(l => [...l, `🟡 Skipping swap, no input amount.`]);
                                break;
                            }
                            signature = await executeSwap(connection, fromWallet, step.poolId!, step.inputMint!, amountIn);
                            setLog(l => [...l, `✅ Swap successful. Sig: ${signature?.substring(0,12)}...`]);
                            break;

                        case 'token-transfer':
                            setLog(l => [...l, `➡️ Transferring SPL Token...`]);
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
    }, [depositWallet, mixMinutes, tradingWallets, refreshBalance]);
    
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
        setPlan(null);
        setRunning(false);
        refreshBalance();
    };

    // --- Other handlers (handleTradingWalletChange, handleCopy, waitForDeposit) remain the same ---
    const handleTradingWalletChange = (index: number, value: string) => {
        const newWallets = [...tradingWallets];
        newWallets[index] = value;
        setTradingWallets(newWallets);
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
           {/* JSX is unchanged */}
        </main>
    );
}