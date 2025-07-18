import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  SendTransactionError,
} from "@solana/web3.js";

// Generate a new random wallet
export function createNewWallet(): Keypair {
  return Keypair.generate();
}

// Airdrop SOL to a wallet (Devnet only)
export async function airdropSol(
  connection: Connection,
  pubkey: PublicKey,
  amount: number
) {
  const sig = await connection.requestAirdrop(
    pubkey,
    amount * LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(sig, "confirmed");
}

// Get wallet balance (in SOL)
export async function getBalance(
  connection: Connection,
  pubkey: PublicKey
): Promise<number> {
  const lamports = await connection.getBalance(pubkey);
  return lamports / LAMPORTS_PER_SOL;
}

export async function sendSol(
  connection: Connection,
  from: Keypair,
  to: PublicKey,
  amount: number
): Promise<string> {
  try {
    if (amount <= 0) throw new Error("Amount must be greater than 0.");
    const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
    if (lamports <= 0) throw new Error("Amount is too small to be sent.");

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: to,
        lamports,
      })
    );
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = from.publicKey;

    return await sendAndConfirmTransaction(connection, tx, [from]);
  } catch (err) {
    if (err instanceof SendTransactionError) {
      console.error("Solana Transaction Error:", await err.getLogs(connection));
    }
    throw err;
  }
}

/**
 * Sweeps the entire SOL balance of an account to a recipient, minus the transaction fee.
 * @param connection The Solana connection object.
 * @param from The Keypair of the account to sweep.
 * @param to The PublicKey of the recipient.
 * @returns A promise that resolves with the transaction signature and amount swept, or null if the balance was too low.
 */
export async function sweepSol(
    connection: Connection,
    from: Keypair,
    to: PublicKey
): Promise<{signature: string | null, amount: number}> {
    const balance = await connection.getBalance(from.publicKey);
    
    // Estimate the fee (5000 lamports is a safe default for a simple transfer)
    const fee = 5000;

    // Only proceed if the balance is greater than the fee
    if (balance <= fee) {
        return { signature: null, amount: 0 };
    }

    const amountToSend = balance - fee;

    try {
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: from.publicKey,
                toPubkey: to,
                lamports: amountToSend,
            })
        );
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = from.publicKey;

        const signature = await sendAndConfirmTransaction(connection, tx, [from]);
        return { signature, amount: amountToSend / LAMPORTS_PER_SOL };
    } catch (err) {
        if (err instanceof SendTransactionError) {
            console.error(`Sweep failed for ${from.publicKey.toBase58()}. Logs:`, await err.getLogs(connection));
        }
        throw err;
    }
}



