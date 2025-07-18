// src/utils/raydiumSdkAdapter.js
// VERSION v71 - Adapted for network-aware Raydium SDK initialization

// --- Consolidated Imports ---
import {
    Raydium,
    DEVNET_PROGRAM_ID, // For Devnet
    ALL_PROGRAM_ID,    // For Mainnet (as identified from your SDK's type definitions)
    getCreatePoolKeys,
    makeCreateCpmmPoolInInstruction as makeCreateCpmmPoolIx,
    ApiV3PoolInfoStandardItemCpmm, // Assuming these are used by your other functions
    CpmmKeys,
    CpmmRpcData,
    CurveCalculator,
    TradeV2,
    Token,
    TokenAmount,
    Percent,
    fetchMultipleMintInfos,
    getPdaPoolAuthority,
    makeSwapCpmmBaseInInstruction // Consolidating this here as well
} from '@raydium-io/raydium-sdk-v2';

import {
    Connection, // Keep if used directly in this file, though initRaydiumSdk receives it
    PublicKey,
    Transaction,
    SystemProgram,
    ComputeBudgetProgram,
    VersionedTransaction,
    Commitment, // Keep if used
    TransactionInstruction, // Keep if used
    getParsedAccountInfo, // Keep if used by other functions
    TransactionMessage, // Keep if used
} from '@solana/web3.js';

import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
    NATIVE_MINT,
    createCloseAccountInstruction,
    getMint, // <<< ADD THIS IMPORT
} from '@solana/spl-token';

import BN from 'bn.js';
import Decimal from 'decimal.js';
import { Buffer } from 'buffer'; // Single import for Buffer

// Your existing local utils
// import { getSimulatedPool, setSimulatedPool, updateSimulatedPoolAfterTrade } from './simulatedPoolStore'; // Assuming this is correct
// import { createWalletAdapter } from './walletAdapter'; // Assuming this is correct

Decimal.set({ precision: 50 });

// --- Helper: JSON Stringify Replacer ---
function replacer(key, value) {
    if (typeof value === 'bigint') { return value.toString() + 'n'; }
    if (value instanceof BN) { return value.toString(); }
    if (value instanceof PublicKey) { return value.toBase58(); }
    if (value instanceof TokenAmount) { return { raw: value.raw.toString(), toExact: value.toExact() }; }
    if (value instanceof Buffer) { return value.toString('hex'); }
    return value;
}

// --- Helper: Send Transaction ---
async function sendAndConfirmSignedTransaction(connection, signedTransaction) {
       console.log("[Helper] -> sendAndConfirmSignedTransaction - Sending...");
    try {
        if (!signedTransaction) throw new Error('Invalid signed transaction object');
        const rawTransaction = signedTransaction.serialize();
        const signature = await connection.sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 5 });
        console.log(`[Helper] TX Sent. Sig: ${signature}. Confirming...`);

        let blockhash;
        let lastValidBlockHeight;
        if (signedTransaction instanceof VersionedTransaction) {
            blockhash = signedTransaction.message.recentBlockhash;
            const fetched = await connection.getLatestBlockhash('confirmed');
            lastValidBlockHeight = fetched.lastValidBlockHeight;
        } else if (signedTransaction instanceof Transaction) {
            blockhash = signedTransaction.recentBlockhash;
            lastValidBlockHeight = signedTransaction.lastValidBlockHeight;
            if (!lastValidBlockHeight) {
                const fetched = await connection.getLatestBlockhash('confirmed');
                lastValidBlockHeight = fetched.lastValidBlockHeight;
            }
        } else {
            console.warn("[Helper] Unknown transaction type, attempting to fetch blockhash for confirmation.");
            const fetched = await connection.getLatestBlockhash('confirmed');
            blockhash = fetched.blockhash;
            lastValidBlockHeight = fetched.lastValidBlockHeight;
        }

        if (!blockhash || !lastValidBlockHeight) {
            throw new Error("[Helper] Could not determine blockhash or lastValidBlockHeight for confirmation.");
        }

        const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (confirmation.value.err) {
            console.error("[Helper] TX Confirmation Error:", confirmation.value.err);
            try {
                const failedTx = await connection.getTransaction(signature, {maxSupportedTransactionVersion: 0, commitment: 'confirmed'});
                console.error("[Helper] Failed TX Logs:", failedTx?.meta?.logMessages?.join('\n'));
            } catch (logError) {
                console.warn("Could not fetch logs for failed tx:", logError);
            }
            throw new Error(`TX failed confirmation: ${JSON.stringify(confirmation.value.err)}`);
        }
        console.log(`[Helper] ✅ TX Confirmed. Sig: ${signature}`);
        return signature;
    } catch (error) {
        console.error('[Helper] send/confirm error:', error);
        throw error;
    }
}

// --- Helper: Sign and Send Transaction ---
async function signAndSendTransaction(connection, wallet, transaction) {
    if (!wallet || typeof wallet.signTransaction !== 'function') { throw new Error("Invalid wallet object provided for signing."); }
     console.log("[Helper] -> signAndSendTransaction - Signing transaction...");
    try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

        if (transaction instanceof VersionedTransaction) {
            console.warn("[Helper] signAndSend received VersionedTransaction. Blockhash/FeePayer set via message. signer:", transaction.message.payerKey.toBase58());
            if (!transaction.message.payerKey) {
                console.warn("[Helper] VersionedTransaction message missing payerKey. Wallet PK should be used when creating TransactionMessage.");
            }
        } else if (transaction instanceof Transaction) {
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = wallet.publicKey;
            transaction.lastValidBlockHeight = lastValidBlockHeight;
            console.log("[Helper] signAndSend received legacy Transaction. Blockhash/FeePayer set.");
        } else {
            throw new Error("[Helper] Unknown transaction type passed to signAndSendTransaction.");
        }

        const signedTx = await wallet.signTransaction(transaction);
        console.log("[Helper] Transaction signed. Sending...");
        return await sendAndConfirmSignedTransaction(connection, signedTx);
    } catch (error) {
        console.error('[Helper] signAndSend error:', error);
        throw error;
    }
}

// --- initRaydiumSdk (Corrected for Network Awareness) ---
export const initRaydiumSdk = async (wallet, connection, currentNetwork) => {
    console.log(`[SDK Init] -> initRaydiumSdk v25 (Corrected Imports): Initializing SDK instance for network: ${currentNetwork}...`);
    if (!wallet?.publicKey) {
        console.error('[SDK Init] No wallet or wallet.publicKey provided.');
        return null;
    }

    let ownerPublicKey;
    try {
        ownerPublicKey = wallet.publicKey instanceof PublicKey ? wallet.publicKey : new PublicKey(wallet.publicKey.toString());
    } catch (e) {
        console.error(`[SDK Init] Invalid wallet public key format: ${e.message}`);
        throw new Error(`[SDK Init] Invalid wallet public key format: ${e.message}`);
    }

    if (typeof window !== 'undefined' && !window.Buffer) {
        window.Buffer = Buffer;
    }

    try {
        const cluster = currentNetwork === 'mainnet-beta' ? 'mainnet' : 'devnet';
        const programIdConfig = currentNetwork === 'mainnet-beta' ? ALL_PROGRAM_ID : DEVNET_PROGRAM_ID;

        console.log(`[SDK Init] Owner PK: ${ownerPublicKey.toString()}`);
        console.log(`[SDK Init] RPC Endpoint: ${connection.rpcEndpoint}`);
        console.log(`[SDK Init] Target Raydium SDK Cluster: ${cluster}`);
        console.log(`[SDK Init] Using Program ID Config for: ${currentNetwork}`, programIdConfig ? "Present" : "Missing");

        if (!programIdConfig) {
            console.error(`[SDK Init] Program ID Config is missing for network: ${currentNetwork}. Ensure ALL_PROGRAM_ID or DEVNET_PROGRAM_ID is correctly imported and available from @raydium-io/raydium-sdk-v2.`);
            return null;
        }
        
        const sdkInstance = await Raydium.load({
            owner: ownerPublicKey,
            connection,
            cluster: cluster,
            programIdConfig: programIdConfig,
            disableLoadToken: true,
            disableFeatureCheck: true
        });

        console.log(`[SDK Init] ✅ Raydium SDK initialized for ${cluster}.`);
        sdkInstance._originalWallet = wallet;
        console.log("[SDK Init] Stored original wallet on SDK instance.");
        return sdkInstance;

    } catch (error) {
        console.error(`[SDK Init] ❌ SDK Init Fail for network ${currentNetwork}:`, error);
        if (error.message) console.error(`[SDK Init] Error message: ${error.message}`);
        if (error.stack) console.error(`[SDK Init] Error stack: ${error.stack}`);
        return null;
    }
};

// --- ensureAtaExists ---
export const getAtaAddressAndCreateInstruction = async (connection, ownerPublicKey, tokenMint) => {
    // ... function content from your file
};

// --- ensureWSOLAccount ---
export const getWSOLAccountAndInstructions = async (connection, ownerPublicKey, amountBN) => {
    // ... function content from your file
};

// --- Create Raydium Liquidity Pool ---
export const createRaydiumPool = async (
    wallet,
    connection,
    tokenAddress,
    tokenDecimals,
    tokenAmountBN,
    solLamportsBN,
    priorityFeeMicroLamports = 50000,
) => {
    // ... function content from your file
};

// --- Swap Raydium Tokens ---
export const swapRaydiumTokens = async (
    wallet, connection, poolIdString, inputMintAddress, amountInBN, slippage, priorityFeeMicroLamports = 50000
) => {
    // ... function content from your file
};

// --- Unwrap WSOL Function ---
export const unwrapWsol = async (wallet, connection) => {
    // ... function content from your file
};

// --- isRaydiumPool (Helper, unchanged) ---
export const isRaydiumPool = (pool) => {
    return pool && !!pool.raydiumPoolId;
};