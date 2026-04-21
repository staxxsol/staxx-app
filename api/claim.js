const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = require("@solana/web3.js");
const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");
const nacl = require("tweetnacl");

const STAXX_MINT = new PublicKey("HTj2djkjfweg21C2MutrXcawb9VuTqeazhQttWLrpump");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const MAX_CLAIM = 100000;
const RATE_LIMIT_MS = 60000;
const claimTimes = new Map();

function createTokenTransferInstruction(source, dest, owner, amount, programId) {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  return new TransactionInstruction({
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId,
    data,
  });
}

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

    const last = claimTimes.get(walletAddress);
    if (last && Date.now() - last < RATE_LIMIT_MS) {
      return res.status(429).json({ error: "Too fast. Wait 60s." });
    }

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

    if (!message.includes("Amount: " + amt + " $STAXX") || !message.includes("Wallet: " + walletAddress)) {
      return res.status(400).json({ error: "Message mismatch" });
    }

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

    // Find which token program the mint uses
    const mintAccountInfo = await conn.getAccountInfo(STAXX_MINT);
    const tokenProgramId = mintAccountInfo.owner;
    const isToken2022 = tokenProgramId.equals(TOKEN_2022_PROGRAM);

    // Find treasury token account
    const treasuryTokenAccounts = await conn.getParsedTokenAccountsByOwner(treasury.publicKey, { mint: STAXX_MINT }, { commitment: "confirmed" });

    if (treasuryTokenAccounts.value.length === 0) {
      return res.status(400).json({ error: "Treasury has no STAXX" });
    }

    const treasuryTokenAccount = treasuryTokenAccounts.value[0];
    const treasuryATA = new PublicKey(treasuryTokenAccount.pubkey);
    const decimals = treasuryTokenAccount.account.data.parsed.info.tokenAmount.decimals;
    const balance = treasuryTokenAccount.account.data.parsed.info.tokenAmount.uiAmount;
    const raw = Math.floor(amt * Math.pow(10, decimals));

    if (amt > balance) {
      return res.status(400).json({ error: "Treasury balance too low. Has: " + balance });
    }

    // Find user token account
    const userTokenAccounts = await conn.getParsedTokenAccountsByOwner(userPubKey, { mint: STAXX_MINT }, { commitment: "confirmed" });

    const tx = new Transaction();
    let destAccount;

    if (userTokenAccounts.value.length > 0) {
      destAccount = new PublicKey(userTokenAccounts.value[0].pubkey);
    } else {
      // Create ATA for user using the correct token program
      const userATA = await getAssociatedTokenAddress(STAXX_MINT, userPubKey, false, tokenProgramId);
      tx.add(createAssociatedTokenAccountInstruction(
        treasury.publicKey,
        userATA,
        userPubKey,
        STAXX_MINT,
        tokenProgramId
      ));
      destAccount = userATA;
    }

    // Use the correct token program for the transfer
    tx.add(createTokenTransferInstruction(
      treasuryATA,
      destAccount,
      treasury.publicKey,
      raw,
      tokenProgramId
    ));

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
