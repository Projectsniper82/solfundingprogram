import {
  Keypair,
  PublicKey,
  Connection,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

export type WalletNode = {
  keypair: Keypair | null;
  pubkey: PublicKey;
  label: string;
  id: string;
};

export type FundingPlanStep = {
  from: string; // node id
  to: string;   // node id
  amount: number;
  sendTime: number; // seconds since start
};

export type FundingGraph = {
  nodes: WalletNode[];
  edges: FundingPlanStep[];
  fundingSource: Keypair | null;
  fundingSourcePubkey: PublicKey;
  recipients: PublicKey[];
};

function makeId() {
  return Math.random().toString(36).substring(2, 10);
}

export async function getSolanaTxFee(
  connection: Connection,
  from: PublicKey,
  to: PublicKey
): Promise<number> {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: to,
      lamports: 1,
    })
  );
  tx.feePayer = from;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  const message = tx.compileMessage();
  const feeResp = await connection.getFeeForMessage(message);
  if (!feeResp.value) throw new Error("Unable to fetch fee from getFeeForMessage");
  return feeResp.value;
}


export async function buildFundingGraph(
  connection: Connection,
  fundingSource: Keypair | null,
  fundingSourcePubkey: PublicKey,
  recipients: PublicKey[], // Expects 6 bot wallets
  totalSol: number,
  totalSeconds: number
): Promise<FundingGraph> {
  
  const NUM_LAYER_1_HUBS = 2;
  const NUM_LAYER_2_DISTRIBUTORS = 4;
  const intermediateWallets: WalletNode[] = [];

  for (let i = 0; i < NUM_LAYER_1_HUBS + NUM_LAYER_2_DISTRIBUTORS; i++) {
    const kp = Keypair.generate();
    intermediateWallets.push({
      keypair: kp,
      pubkey: kp.publicKey,
      label: i < NUM_LAYER_1_HUBS ? `Hub ${i + 1}` : `Distributor ${i - NUM_LAYER_1_HUBS + 1}`,
      id: makeId(),
    });
  }

  const recipientNodes: WalletNode[] = recipients.map((pubkey, idx) => ({
    keypair: null,
    pubkey,
    label: `Bot Wallet ${idx + 1}`,
    id: "RECIPIENT_" + idx,
  }));

  const sourceNode: WalletNode = {
    keypair: fundingSource,
    pubkey: fundingSourcePubkey,
    label: "Source",
    id: "SOURCE",
  };
  
  const txFeeLamports = 5000;
  const txFeeSOL = txFeeLamports / LAMPORTS_PER_SOL;
  
  const rentExemptionLamports = await connection.getMinimumBalanceForRentExemption(0);
  const rentExemptionSOL = rentExemptionLamports / LAMPORTS_PER_SOL;

  const totalTransactions = NUM_LAYER_1_HUBS + NUM_LAYER_2_DISTRIBUTORS + recipients.length;
  const totalFees = totalTransactions * txFeeSOL;
  const totalRent = (NUM_LAYER_1_HUBS + NUM_LAYER_2_DISTRIBUTORS) * rentExemptionSOL;
  const totalCost = totalFees + totalRent;

  if (totalSol <= totalCost) {
    throw new Error(`Deposit of ${totalSol} SOL is not enough to cover fees (${totalFees}) and rent (${totalRent}). Total cost: ${totalCost}`);
  }

  const amountToDistribute = totalSol - totalCost;
  const recipientAmounts = randomSplit(amountToDistribute, recipients.length);
  
  const edges: FundingPlanStep[] = [];
  const hubs = intermediateWallets.slice(0, NUM_LAYER_1_HUBS);
  const distributors = intermediateWallets.slice(NUM_LAYER_1_HUBS);

  const distributorRecipientAssignments: { [distId: string]: { node: WalletNode, amount: number }[] } = {};
  distributors.forEach(d => distributorRecipientAssignments[d.id] = []);
  recipients.forEach((r, i) => distributorRecipientAssignments[distributors[i % NUM_LAYER_2_DISTRIBUTORS].id].push({ node: recipientNodes[i], amount: recipientAmounts[i] }));
  
  const hubDistributorAssignments: { [hubId: string]: WalletNode[] } = {};
  hubs.forEach(h => hubDistributorAssignments[h.id] = []);
  distributors.forEach((d, i) => hubDistributorAssignments[hubs[i % NUM_LAYER_1_HUBS].id].push(d));

  // CORRECTED LOGIC
  // Stage 1: Source -> Hubs
  hubs.forEach(hub => {
    let amountToFundHub = 0;
    // This hub needs to pay fees to fund its distributors
    amountToFundHub += hubDistributorAssignments[hub.id].length * txFeeSOL;

    hubDistributorAssignments[hub.id].forEach(dist => {
      // It also needs to send the distributors enough for rent, future fees, and the final amounts
      amountToFundHub += rentExemptionSOL; // Rent for the distributor
      const assignedRecipients = distributorRecipientAssignments[dist.id];
      amountToFundHub += assignedRecipients.length * txFeeSOL; // Fees for final transfers
      amountToFundHub += assignedRecipients.reduce((sum, r) => sum + r.amount, 0); // Final amounts
    });

    if (amountToFundHub > 0) {
      edges.push({
        from: sourceNode.id, to: hub.id, amount: amountToFundHub,
        sendTime: Math.floor(Math.random() * totalSeconds * 0.2)
      });
    }
  });

  // Stage 2: Hubs -> Distributors
  hubs.forEach(hub => {
    hubDistributorAssignments[hub.id].forEach(dist => {
      const assignedRecipients = distributorRecipientAssignments[dist.id];
      const totalForRecipients = assignedRecipients.reduce((sum, r) => sum + r.amount, 0);
      const feesForNextStage = assignedRecipients.length * txFeeSOL;
      const amountToFundDistributor = totalForRecipients + feesForNextStage;

      if (amountToFundDistributor > 0) {
        edges.push({
          from: hub.id, to: dist.id, amount: amountToFundDistributor,
          sendTime: Math.floor(totalSeconds * 0.2 + Math.random() * totalSeconds * 0.3)
        });
      }
    });
  });

  // Stage 3: Distributors -> Recipients
  distributors.forEach(dist => {
    distributorRecipientAssignments[dist.id].forEach(recipient => {
      edges.push({
        from: dist.id, to: recipient.node.id, amount: recipient.amount,
        sendTime: Math.floor(totalSeconds * 0.5 + Math.random() * totalSeconds * 0.5)
      });
    });
  });
  
  edges.sort((a, b) => a.sendTime - b.sendTime);

  return {
    nodes: [sourceNode, ...intermediateWallets, ...recipientNodes],
    edges,
    fundingSource,
    fundingSourcePubkey,
    recipients,
  };
}

function randomSplit(total: number, n: number): number[] {
  if (n <= 0 || total <= 0) return [];
  if (n === 1) return [total];

  const equalShare = total / n;
  // Variation: Each wallet's amount can vary by up to 30% (+/- 15%) from the equal share.
  // You can adjust this percentage to make the amounts more or less similar.
  const variationPercentage = 0.30; 

  let initialShares = Array(n).fill(0).map(() => {
    const jitter = (Math.random() - 0.5) * variationPercentage; // -0.15 to +0.15
    return equalShare * (1 + jitter);
  });

  // Normalize the shares to ensure their sum is exactly equal to the total amount.
  const currentTotal = initialShares.reduce((sum, val) => sum + val, 0);
  const normalizationFactor = total / currentTotal;
  
  const finalShares = initialShares.map(share => share * normalizationFactor);
  
  return finalShares;
}

function randomSample<T>(arr: T[], n: number): T[] {
  let copy = [...arr];
  let out: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    let idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}