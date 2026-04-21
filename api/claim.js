const { Connection, Keypair, PublicKey, Transaction } = require("@solana/web3.js");
const {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
} = require("@solana/spl-token");
const bs58 = require("bs58");
const nacl = require("tweetnacl");

const STAXX_MINT = new PublicKey("HTj2djkjfweg21C2MutrXcawb9VuTqeazhQttWLrpump");
const MAX_CLAIM = 100000;
const RATE_LIMIT_MS = 60000;
const claimTimes = new Map();

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { walletAddress, amount, signature, message } = req.body;
    if (!walletAddress || !amount || !signature || !message) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0 || amt > MAX_CLAIM) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // Rate limit
    const last = claimTimes.get(walletAddress);
    if (last && Date.now() - last < RATE_LIMIT_MS) {
      return res.status(429).json({ error: "Too fast. Wait 60s between claims." });
    }

    // Verify signature
    let userPubKey;
    try {
      userPubKey = new PublicKey(walletAddress);
      const msgBytes = new TextEncoder().encode(message);
      const sigBytes = bs58.decode(signature);
      const valid = nacl.sign.detached.verify(msgBytes, sigBytes, userPubKey.toBytes());
      if (!valid) return res.status(401).json({ error: "Bad signature" });
    } catch (e) {
      return res.status(401).json({ error: "Sig verify failed: " + e.message });
    }

    // Verify message matches claim
    if (!message.includes("Amount: " + amt + " $STAXX") || !message.includes("Wallet: " + walletAddress)) {
      return res.status(400).json({ error: "Message mismatch" });
    }

    // Load treasury
    const pk = process.env.TREASURY_PRIVATE_KEY;
    if (!pk) return res.status(500).json({ error: "Server not configured" });

    let treasury;
    try {
      treasury = Keypair.fromSecretKey(bs58.decode(pk));
    } catch (e) {
      return res.status(500).json({ error: "Bad server config" });
    }

    const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    const conn = new Connection(rpc, "confirmed");

    const treasuryATA = await getAssociatedTokenAddress(STAXX_MINT, treasury.publicKey);
    const userATA = await getAssociatedTokenAddress(STAXX_MINT, userPubKey);

    // Check treasury balance
    const acct = await getAccount(conn, treasuryATA);
    const mintInfo = await conn.getParsedAccountInfo(STAXX_MINT);
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals || 6;
    const raw = Math.floor(amt * Math.pow(10, decimals));

    if (Number(acct.amount) < raw) {
      return res.status(400).json({ error: "Treasury low on funds" });
    }

    // Build tx
    const tx = new Transaction();

    // Create user ATA if needed
    try {
      await getAccount(conn, userATA);
    } catch (e) {
      tx.add(createAssociatedTokenAccountInstruction(treasury.publicKey, userATA, userPubKey, STAXX_MINT));
    }

    tx.add(createTransferInstruction(treasuryATA, userATA, treasury.publicKey, raw));

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = treasury.publicKey;
    tx.sign(treasury);

    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

    claimTimes.set(walletAddress, Date.now());

    return res.status(200).json({ success: true, signature: sig, amount: amt });
  } catch (e) {
    console.error("Claim error:", e);
    return res.status(500).json({ error: e.message || "Internal error" });
  }
};
