import {
  Keypair,
  PublicKey,
  Connection,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
// CORRECTED IMPORTS for @solana/spl-token v0.4+
import { 
    createAssociatedTokenAccountInstruction, 
    createTransferInstruction, 
    getAssociatedTokenAddress 
} from "@solana/spl-token";

// ... rest of the file is unchanged ...
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr");
const SOL_USDC_POOL_ID = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqbAaGgG9pKFVEaA";
export type WalletNode = { keypair: Keypair | null; pubkey: PublicKey; label: string; id: string; };
export type FundingPlanStep = { type: 'sol-transfer' | 'swap' | 'token-transfer'; from: string; to: string; amount: number; amountInLamports?: bigint; sendTime: number; poolId?: string; inputMint?: string; outputMint?: string; tokenMint?: string; };
export type FundingGraph = { nodes: WalletNode[]; edges: FundingPlanStep[]; fundingSource: Keypair | null; fundingSourcePubkey: PublicKey; recipients: PublicKey[]; };
function makeId() { return Math.random().toString(36).substring(2, 10); }

export async function buildFundingGraph(
  connection: Connection,
  fundingSource: Keypair | null,
  fundingSourcePubkey: PublicKey,
  recipients: PublicKey[],
  totalSol: number,
  totalSeconds: number
): Promise<FundingGraph> {
  const NUM_INTERMEDIATE = 3;
  const intermediateWallets: WalletNode[] = [];
  for (let i = 0; i < NUM_INTERMEDIATE; i++) { const kp = Keypair.generate(); intermediateWallets.push({ keypair: kp, pubkey: kp.publicKey, label: `Mixer Wallet ${i + 1}`, id: makeId(), }); }
  const recipientNodes: WalletNode[] = recipients.map((pubkey, idx) => ({ keypair: null, pubkey, label: `Bot Wallet ${idx + 1}`, id: "RECIPIENT_" + idx }));
  const sourceNode: WalletNode = { keypair: fundingSource, pubkey: fundingSourcePubkey, label: "Source", id: "SOURCE" };
  const txFeeSOL = 5000 / LAMPORTS_PER_SOL;
  const swapFeeSOL = txFeeSOL * 4;
  const rentExemptionSOL = (await connection.getMinimumBalanceForRentExemption(0)) / LAMPORTS_PER_SOL;
  const totalFees = (txFeeSOL * (1 + recipients.length)) + (swapFeeSOL * 2) + txFeeSOL;
  const totalRent = rentExemptionSOL * (NUM_INTERMEDIATE + 2);
  const totalCost = totalFees + totalRent;
  if (totalSol <= totalCost) { throw new Error(`Deposit of ${totalSol} SOL is not enough. At least ${totalCost.toFixed(4)} is needed.`); }
  const amountToDistribute = totalSol - totalCost;
  const finalAmounts = randomSplit(amountToDistribute, recipients.length);
  const edges: FundingPlanStep[] = [];
  const [mixer1, mixer2, mixer3] = intermediateWallets;
  const initialFundingAmount = amountToDistribute + (swapFeeSOL * 2) + (txFeeSOL * (1 + recipients.length)) + (rentExemptionSOL * (NUM_INTERMEDIATE - 1 + 2));
  edges.push({ type: 'sol-transfer', from: sourceNode.id, to: mixer1.id, amount: initialFundingAmount, sendTime: totalSeconds * 0.05 });
  edges.push({ type: 'swap', from: mixer1.id, to: mixer1.id, amount: 0, amountInLamports: BigInt(Math.floor(amountToDistribute * LAMPORTS_PER_SOL)), sendTime: totalSeconds * 0.25, poolId: SOL_USDC_POOL_ID, inputMint: SOL_MINT.toBase58(), outputMint: USDC_MINT.toBase58(), });
  edges.push({ type: 'token-transfer', from: mixer1.id, to: mixer2.id, amount: 0, tokenMint: USDC_MINT.toBase58(), sendTime: totalSeconds * 0.45 });
  edges.push({ type: 'swap', from: mixer2.id, to: mixer2.id, amount: 0, amountInLamports: BigInt(0), sendTime: totalSeconds * 0.65, poolId: SOL_USDC_POOL_ID, inputMint: USDC_MINT.toBase58(), outputMint: SOL_MINT.toBase58(), });
  edges.push({ type: 'sol-transfer', from: mixer2.id, to: mixer3.id, amount: 0, sendTime: totalSeconds * 0.85 });
  let cumulativeDelay = totalSeconds * 0.90;
  finalAmounts.forEach((finalAmount, i) => { if (finalAmount > 0) { edges.push({ type: 'sol-transfer', from: mixer3.id, to: recipientNodes[i].id, amount: finalAmount, sendTime: cumulativeDelay }); cumulativeDelay += (totalSeconds * 0.1) / recipients.length; } });
  edges.sort((a, b) => a.sendTime - b.sendTime);
  return { nodes: [sourceNode, ...intermediateWallets, ...recipientNodes], edges, fundingSource, fundingSourcePubkey, recipients, };
}

function randomSplit(total: number, n: number): number[] {
  if (n <= 0 || total <= 0) return []; if (n === 1) return [total]; const equalShare = total / n; const variationPercentage = 0.30; let initialShares = Array(n).fill(0).map(() => { const jitter = (Math.random() - 0.5) * variationPercentage; return equalShare * (1 + jitter); }); const currentTotal = initialShares.reduce((sum, val) => sum + val, 0); const normalizationFactor = total / currentTotal; return initialShares.map(share => share * normalizationFactor);
}

export async function sendSplToken(connection: Connection, from: Keypair, to: PublicKey, tokenMint: PublicKey) {
    const fromAta = await getAssociatedTokenAddress(tokenMint, from.publicKey); const toAta = await getAssociatedTokenAddress(tokenMint, to); const balance = await connection.getTokenAccountBalance(fromAta); const amountLamports = BigInt(balance.value.amount); if (amountLamports === BigInt(0)) { console.log("No token balance to send."); return; } const toAtaInfo = await connection.getAccountInfo(toAta); const instructions: TransactionInstruction[] = []; if (!toAtaInfo) { instructions.push(createAssociatedTokenAccountInstruction(from.publicKey, toAta, to, tokenMint)); } instructions.push(createTransferInstruction(fromAta, toAta, from.publicKey, amountLamports)); const tx = new Transaction().add(...instructions); tx.feePayer = from.publicKey; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash; return await sendAndConfirmTransaction(connection, tx, [from]);
}