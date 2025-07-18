// app/solanaUtils.ts
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

/**
 * Gets the SOL balance of a given public key.
 * @returns Balance in SOL.
 */
export async function getBalance(connection: Connection, publicKey: PublicKey): Promise<number> {
  const lamports = await connection.getBalance(publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Sends a specific amount of SOL from one keypair to a public key.
 * @returns The transaction signature.
 */
export async function sendSol(
  connection: Connection,
  from: Keypair,
  to: PublicKey,
  amountSol: number
): Promise<string> {
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
    })
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [from]);
  return signature;
}

/**
 * Sweeps the entire SOL balance (minus fees) from a keypair to a public key.
 * @returns An object containing the transaction signature.
 */
export async function sweepSol(
  connection: Connection,
  from: Keypair,
  to: PublicKey
): Promise<{ signature: string; amount: number }> { // <-- Return type updated
  const balance = await connection.getBalance(from.publicKey);
  // Reserve lamports for transaction fee
  const fee = 5000;
  const amountToSend = balance - fee;

  if (amountToSend <= 0) {
    console.log("Balance too low to sweep.");
    return { signature: "skipped-low-balance", amount: 0 };
  }

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: amountToSend,
    })
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [from]);
  // Return both signature and amount in SOL
  return { signature, amount: amountToSend / LAMPORTS_PER_SOL };
}