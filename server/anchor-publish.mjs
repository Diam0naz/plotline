// anchor-publish.mjs — publish the registry log head to Solana as a memo transaction.
//
// WHY: The Plotline ledger is tamper-evident (hash-chained) but mutable while the
// operator controls the only copy. Publishing the head hash to a Solana memo makes
// it publicly timestamped and immutable — anyone can verify the log has not been
// rewound by comparing the on-chain memo to the current head.
//
// This module is a STUB. It compiles and exports the right interface; to make it
// live, supply SOLANA_RPC_URL and SOLANA_PAYER_KEYPAIR_JSON environment variables
// and install @solana/web3.js + @solana/spl-memo (or use the raw web3.js memo
// program ID directly).
//
// MEMO PROGRAM (mainnet + devnet + testnet):
//   MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr
//   (SPL Memo Program v2)
//
// WHAT IS WRITTEN:
//   A UTF-8 memo of the form:
//     plotline:log:<seq>:<hash_hex>:<iso_timestamp>
//   e.g.
//     plotline:log:47:a3f9…:2026-11-05T18:00:00.000Z
//
// The operator calls POST /api/anchor/publish (operator-token required) and gets
// back the transaction signature (or a dry-run result in stub mode).
//
// ─────────────────────────────────────────────────────────────────────────────

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * Build the memo string for a given log head.
 * @param {{ seq: number, hash: string }} head
 * @param {Date} [now]
 * @returns {string}
 */
export function buildMemo(head, now = new Date()) {
  return `plotline:log:${head.seq}:${head.hash}:${now.toISOString()}`;
}

/**
 * Publish the log head to Solana as a memo transaction.
 *
 * In stub mode (no SOLANA_RPC_URL set) this returns a dry-run result so the
 * operator can see what would be sent without needing a funded wallet.
 *
 * @param {{ seq: number, hash: string }} head - registry log head
 * @param {{ rpcUrl?: string, payerKeypairJson?: string, dryRun?: boolean, now?: () => Date }} opts
 * @returns {Promise<AnchorPublishResult>}
 */
export async function publishHead(head, {
  rpcUrl = process.env.SOLANA_RPC_URL,
  payerKeypairJson = process.env.SOLANA_PAYER_KEYPAIR_JSON,
  dryRun = false,
  now = () => new Date(),
} = {}) {
  const memo = buildMemo(head, now());
  const ts = now().toISOString();

  // ── Dry-run / stub path ────────────────────────────────────────────────
  if (!rpcUrl || !payerKeypairJson || dryRun) {
    return {
      ok: true,
      mode: 'dry_run',
      memo,
      head,
      ts,
      signature: null,
      message: rpcUrl
        ? 'dry_run=true: transaction not submitted'
        : 'SOLANA_RPC_URL not set: running in stub mode. Set SOLANA_RPC_URL and SOLANA_PAYER_KEYPAIR_JSON to go live.',
    };
  }

  // ── Live path (requires @solana/web3.js to be installed) ──────────────
  //
  // Install:  npm install @solana/web3.js
  //
  // The code below is intentionally wrapped in a dynamic import so the server
  // still starts and works without the package installed. It will fail at
  // runtime only when a live publish is attempted without the dependency.
  //
  try {
    // Dynamic import so absence of the package is a runtime error, not a
    // startup crash.
    const { Connection, Keypair, Transaction, TransactionInstruction, PublicKey, sendAndConfirmTransaction } =
      await import('@solana/web3.js').catch(() => {
        throw new Error('@solana/web3.js is not installed. Run: npm install @solana/web3.js');
      });

    const connection = new Connection(rpcUrl, 'confirmed');
    const payer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(payerKeypairJson)),
    );

    const memoInstruction = new TransactionInstruction({
      keys: [],
      programId: new PublicKey(MEMO_PROGRAM_ID),
      data: Buffer.from(memo, 'utf8'),
    });

    const tx = new Transaction().add(memoInstruction);
    const signature = await sendAndConfirmTransaction(connection, tx, [payer]);

    return {
      ok: true,
      mode: 'live',
      memo,
      head,
      ts,
      signature,
      explorer: `https://explorer.solana.com/tx/${signature}`,
    };
  } catch (err) {
    return {
      ok: false,
      mode: 'live',
      memo,
      head,
      ts,
      signature: null,
      error: String(err?.message ?? 'unknown error').slice(0, 300),
    };
  }
}

/**
 * @typedef {Object} AnchorPublishResult
 * @property {boolean} ok
 * @property {'dry_run'|'live'} mode
 * @property {string} memo
 * @property {{ seq: number, hash: string }} head
 * @property {string} ts
 * @property {string|null} signature
 * @property {string} [explorer]
 * @property {string} [message]
 * @property {string} [error]
 */
