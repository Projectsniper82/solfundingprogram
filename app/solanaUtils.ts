import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
// CORRECTED: Filename is all lowercase
import { swapRaydiumTokens } from './raydiumsdkadapter.js'; 
import BN from 'bn.js';

class KeypairWalletAdapter {
    private keypair: Keypair;
    constructor(keypair: Keypair) { this.keypair = keypair; }
    get publicKey(): PublicKey { return this.keypair.publicKey; }
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
        if (tx instanceof VersionedTransaction) { tx.sign([this.keypair]); } 
        else if (tx instanceof Transaction) { tx.partialSign(this.keypair); }
        return tx;
    }
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
        return txs.map((t) => {
            if (t instanceof VersionedTransaction) { t.sign([this.keypair]); } 
            else if (t instanceof Transaction) { t.partialSign(this.keypair); }
            return t;
        });
    }
}

export async function executeSwap(
    connection: Connection,
    walletKeypair: Keypair,
    poolId: string, 
    inputMint: string, 
    amountIn: BN, 
    slippage: number = 0.01 
) {
    const wallet = new KeypairWalletAdapter(walletKeypair);
    console.log(`Executing swap on Raydium for pool ${poolId}`);
    try {
        const signature = await swapRaydiumTokens(
            wallet, connection, poolId, inputMint, amountIn, slippage
        );
        return signature;
    } catch (error) {
        console.error("Error during swap execution:", error);
        throw error;
    }
}