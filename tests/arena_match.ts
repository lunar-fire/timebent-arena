import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { createHash } from "crypto";

// Program ID
const PROGRAM_ID = new PublicKey("45A9Qb4YVeWwL35aBCTcT4bcfsgcFUW3GUHAbvhNJJGi");

// Session Keys program ID (used as placeholder for None)
const SESSION_KEYS_PROGRAM_ID = new PublicKey("KeyspBbvfpjBRDMu6FJR3bTkfvBsGNHPJBXoKPmecnT");

// Seeds
const MATCH_SEED = Buffer.from("arena_match");
const PLAYER_STATE_SEED = Buffer.from("player_state");

// Game constants (must match program)
const HP_PER_ROUND = 3;
const DAMAGE_COOLDOWN_TICKS = 10;

// ── Helpers ─────────────────────────────────────────────────────────────────

function matchIdToBytes(matchId: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(matchId));
  return buf;
}

function findMatchPda(matchId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MATCH_SEED, matchIdToBytes(matchId)],
    PROGRAM_ID
  );
}

function findPlayerStatePda(matchId: number, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PLAYER_STATE_SEED, matchIdToBytes(matchId), player.toBuffer()],
    PROGRAM_ID
  );
}

// ── Account Deserialization ─────────────────────────────────────────────────

interface ArenaMatchState {
  matchId: bigint;
  gameServer: PublicKey;
  player1: PublicKey;
  player2: PublicKey;
  status: number;
  currentRound: number;
  player1RoundsWon: number;
  player2RoundsWon: number;
  player1Hp: number;
  player2Hp: number;
  currentTick: number;
  roundStartTick: number;
  lastP1DamageTick: number;
  lastP2DamageTick: number;
  winner: PublicKey;
  createdAt: bigint;
  settledAt: bigint;
}

function decodeMatchState(data: Buffer): ArenaMatchState {
  let offset = 8; // discriminator
  const matchId = data.readBigUInt64LE(offset); offset += 8;
  const gameServer = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const player1 = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const player2 = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const status = data.readUInt8(offset); offset += 1;
  const currentRound = data.readUInt8(offset); offset += 1;
  const player1RoundsWon = data.readUInt8(offset); offset += 1;
  const player2RoundsWon = data.readUInt8(offset); offset += 1;
  const player1Hp = data.readUInt8(offset); offset += 1;
  const player2Hp = data.readUInt8(offset); offset += 1;
  const currentTick = data.readUInt32LE(offset); offset += 4;
  const roundStartTick = data.readUInt32LE(offset); offset += 4;
  const lastP1DamageTick = data.readUInt32LE(offset); offset += 4;
  const lastP2DamageTick = data.readUInt32LE(offset); offset += 4;
  const winner = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const createdAt = data.readBigInt64LE(offset); offset += 8;
  const settledAt = data.readBigInt64LE(offset);
  return {
    matchId, gameServer, player1, player2, status, currentRound,
    player1RoundsWon, player2RoundsWon, player1Hp, player2Hp,
    currentTick, roundStartTick, lastP1DamageTick, lastP2DamageTick,
    winner, createdAt, settledAt,
  };
}

interface PlayerStateData {
  matchId: bigint;
  player: PublicKey;
  dx: number;
  dy: number;
  attacking: boolean;
  lastTick: number;
  inputCount: bigint;
}

function decodePlayerState(data: Buffer): PlayerStateData {
  let offset = 8;
  const matchId = data.readBigUInt64LE(offset); offset += 8;
  const player = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const dx = data.readInt8(offset); offset += 1;
  const dy = data.readInt8(offset); offset += 1;
  const attacking = data.readUInt8(offset) === 1; offset += 1;
  const lastTick = data.readUInt32LE(offset); offset += 4;
  const inputCount = data.readBigUInt64LE(offset);
  return { matchId, player, dx, dy, attacking, lastTick, inputCount };
}

// ── Instruction Builders ────────────────────────────────────────────────────

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function buildCreateMatchIx(
  matchId: number,
  gameServer: PublicKey,
  player1: PublicKey,
): anchor.web3.TransactionInstruction {
  const [matchPda] = findMatchPda(matchId);
  const data = Buffer.alloc(8 + 8);
  disc("create_match").copy(data, 0);
  data.writeBigUInt64LE(BigInt(matchId), 8);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: matchPda, isSigner: false, isWritable: true },
      { pubkey: gameServer, isSigner: false, isWritable: false },
      { pubkey: player1, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildCreatePlayerStateIx(
  matchId: number,
  player: PublicKey,
): anchor.web3.TransactionInstruction {
  const [playerStatePda] = findPlayerStatePda(matchId, player);
  const data = Buffer.alloc(8 + 8);
  disc("create_player_state").copy(data, 0);
  data.writeBigUInt64LE(BigInt(matchId), 8);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: playerStatePda, isSigner: false, isWritable: true },
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildJoinMatchIx(
  matchId: number,
  player2: PublicKey,
  payer: PublicKey,
): anchor.web3.TransactionInstruction {
  const [matchPda] = findMatchPda(matchId);
  const data = Buffer.alloc(8 + 8);
  disc("join_match").copy(data, 0);
  data.writeBigUInt64LE(BigInt(matchId), 8);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: matchPda, isSigner: false, isWritable: true },
      { pubkey: player2, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      // session_token = None — pass program ID as placeholder
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildServerActionIx(
  instructionName: string,
  matchId: number,
  gameServer: PublicKey,
  extraData?: Buffer,
): anchor.web3.TransactionInstruction {
  const [matchPda] = findMatchPda(matchId);
  const matchIdBuf = Buffer.alloc(8);
  matchIdBuf.writeBigUInt64LE(BigInt(matchId));
  const data = Buffer.concat([disc(instructionName), matchIdBuf, ...(extraData ? [extraData] : [])]);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: matchPda, isSigner: false, isWritable: true },
      { pubkey: gameServer, isSigner: true, isWritable: true },
    ],
    data,
  });
}

function buildApplyDamageIx(
  matchId: number,
  gameServer: PublicKey,
  targetSlot: number,
): anchor.web3.TransactionInstruction {
  const extra = Buffer.alloc(1);
  extra.writeUInt8(targetSlot);
  return buildServerActionIx("apply_damage", matchId, gameServer, extra);
}

function buildForfeitIx(
  matchId: number,
  gameServer: PublicKey,
  forfeiterSlot: number,
): anchor.web3.TransactionInstruction {
  const extra = Buffer.alloc(1);
  extra.writeUInt8(forfeiterSlot);
  return buildServerActionIx("forfeit", matchId, gameServer, extra);
}

function buildSubmitInputIx(
  matchId: number,
  player: PublicKey,
  payer: PublicKey,
  tick: number,
  dx: number,
  dy: number,
  attacking: boolean,
): anchor.web3.TransactionInstruction {
  const [matchPda] = findMatchPda(matchId);
  const [playerStatePda] = findPlayerStatePda(matchId, player);

  const argsBuf = Buffer.alloc(8 + 4 + 1 + 1 + 1);
  let off = 0;
  argsBuf.writeBigUInt64LE(BigInt(matchId), off); off += 8;
  argsBuf.writeUInt32LE(tick, off); off += 4;
  argsBuf.writeInt8(dx, off); off += 1;
  argsBuf.writeInt8(dy, off); off += 1;
  argsBuf.writeUInt8(attacking ? 1 : 0, off);
  const data = Buffer.concat([disc("submit_input"), argsBuf]);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: matchPda, isSigner: false, isWritable: true },
      { pubkey: playerStatePda, isSigner: false, isWritable: true },
      { pubkey: player, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      // session_token = None
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildCancelMatchIx(
  matchId: number,
  player1: PublicKey,
): anchor.web3.TransactionInstruction {
  const [matchPda] = findMatchPda(matchId);
  const data = Buffer.alloc(8 + 8);
  disc("cancel_match").copy(data, 0);
  data.writeBigUInt64LE(BigInt(matchId), 8);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: matchPda, isSigner: false, isWritable: true },
      { pubkey: player1, isSigner: true, isWritable: true },
    ],
    data,
  });
}

function buildCloseMatchIx(
  matchId: number,
  payer: PublicKey,
): anchor.web3.TransactionInstruction {
  const [matchPda] = findMatchPda(matchId);
  const data = Buffer.alloc(8 + 8);
  disc("close_match").copy(data, 0);
  data.writeBigUInt64LE(BigInt(matchId), 8);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: matchPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
    ],
    data,
  });
}

function buildClosePlayerStateIx(
  matchId: number,
  player: PublicKey,
  payer: PublicKey,
): anchor.web3.TransactionInstruction {
  const [matchPda] = findMatchPda(matchId);
  const [playerStatePda] = findPlayerStatePda(matchId, player);
  const data = Buffer.alloc(8 + 8);
  disc("close_player_state").copy(data, 0);
  data.writeBigUInt64LE(BigInt(matchId), 8);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: matchPda, isSigner: false, isWritable: false },
      { pubkey: playerStatePda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
    ],
    data,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("arena-match", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Use provider wallet as "game server" AND player1 for testing (avoids airdrop rate limits)
  const gameServer = (provider.wallet as anchor.Wallet).payer;
  const player1 = gameServer; // game server acts as player1 (same as production flow)
  const player2 = Keypair.generate();

  let matchId: number;

  before(async () => {
    matchId = Math.floor(Math.random() * 1_000_000);

    // Fund player2 via transfer from provider wallet (avoids faucet rate limits)
    const transferIx = SystemProgram.transfer({
      fromPubkey: gameServer.publicKey,
      toPubkey: player2.publicKey,
      lamports: 0.5 * anchor.web3.LAMPORTS_PER_SOL,
    });
    const tx = new anchor.web3.Transaction().add(transferIx);
    await provider.sendAndConfirm(tx, [gameServer]);
  });

  // ── 1. Create match ───────────────────────────────────────────────────

  it("creates a match", async () => {
    const ix = buildCreateMatchIx(matchId, gameServer.publicKey, player1.publicKey);
    const tx = new anchor.web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [player1]);

    const [matchPda] = findMatchPda(matchId);
    const acct = await provider.connection.getAccountInfo(matchPda);
    expect(acct).to.not.be.null;

    const state = decodeMatchState(acct!.data);
    expect(state.matchId).to.equal(BigInt(matchId));
    expect(state.gameServer.toBase58()).to.equal(gameServer.publicKey.toBase58());
    expect(state.player1.toBase58()).to.equal(player1.publicKey.toBase58());
    expect(state.status).to.equal(0); // WaitingForPlayer
    expect(state.player1Hp).to.equal(HP_PER_ROUND);
    expect(state.player2Hp).to.equal(HP_PER_ROUND);
  });

  // ── 2. Create player states ───────────────────────────────────────────

  it("creates player states", async () => {
    const ix1 = buildCreatePlayerStateIx(matchId, player1.publicKey);
    const ix2 = buildCreatePlayerStateIx(matchId, player2.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix1), [player1]);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix2), [player2]);

    const [ps1Pda] = findPlayerStatePda(matchId, player1.publicKey);
    const ps1Acct = await provider.connection.getAccountInfo(ps1Pda);
    expect(ps1Acct).to.not.be.null;

    const ps1 = decodePlayerState(ps1Acct!.data);
    expect(ps1.player.toBase58()).to.equal(player1.publicKey.toBase58());
    expect(ps1.inputCount).to.equal(BigInt(0));
  });

  // ── 3. Join match ─────────────────────────────────────────────────────

  it("player2 joins match", async () => {
    const ix = buildJoinMatchIx(matchId, player2.publicKey, player2.publicKey);
    const tx = new anchor.web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [player2]);

    const [matchPda] = findMatchPda(matchId);
    const acct = await provider.connection.getAccountInfo(matchPda);
    const state = decodeMatchState(acct!.data);

    expect(state.player2.toBase58()).to.equal(player2.publicKey.toBase58());
    expect(state.status).to.equal(1); // Countdown
    expect(state.currentRound).to.equal(1);
  });

  // ── 4. Start round ────────────────────────────────────────────────────

  it("game server starts round", async () => {
    const ix = buildServerActionIx("start_round", matchId, gameServer.publicKey);
    const tx = new anchor.web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [gameServer]);

    const [matchPda] = findMatchPda(matchId);
    const acct = await provider.connection.getAccountInfo(matchPda);
    const state = decodeMatchState(acct!.data);

    expect(state.status).to.equal(2); // Active
    expect(state.player1Hp).to.equal(HP_PER_ROUND);
    expect(state.player2Hp).to.equal(HP_PER_ROUND);
  });

  // ── 5. Submit input ───────────────────────────────────────────────────

  it("player1 submits movement input", async () => {
    const ix = buildSubmitInputIx(matchId, player1.publicKey, player1.publicKey, 1, 1, 0, false);
    const tx = new anchor.web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [player1]);

    const [ps1Pda] = findPlayerStatePda(matchId, player1.publicKey);
    const acct = await provider.connection.getAccountInfo(ps1Pda);
    const ps = decodePlayerState(acct!.data);

    expect(ps.dx).to.equal(1);
    expect(ps.dy).to.equal(0);
    expect(ps.attacking).to.equal(false);
    expect(ps.inputCount).to.equal(BigInt(1));
  });

  // ── 6. Apply damage ───────────────────────────────────────────────────

  it("game server applies damage to player2", async () => {
    // Advance tick first
    const inputIx = buildSubmitInputIx(matchId, player1.publicKey, player1.publicKey, DAMAGE_COOLDOWN_TICKS + 1, 0, 0, true);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(inputIx), [player1]);

    const ix = buildApplyDamageIx(matchId, gameServer.publicKey, 2);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);

    const [matchPda] = findMatchPda(matchId);
    const acct = await provider.connection.getAccountInfo(matchPda);
    const state = decodeMatchState(acct!.data);

    expect(state.player2Hp).to.equal(HP_PER_ROUND - 1);
  });

  // ── 7. Damage cooldown enforcement ────────────────────────────────────

  it("rejects damage during cooldown", async () => {
    const ix = buildApplyDamageIx(matchId, gameServer.publicKey, 2);
    try {
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);
      expect.fail("Should have failed with DamageCooldown");
    } catch (err: any) {
      // Transaction should fail — the program rejects damage during cooldown
      expect(err.toString()).to.include("Simulation failed");
    }
  });

  // ── 8. Full round — P1 wins ───────────────────────────────────────────

  it("P1 wins round 1 via damage", async () => {
    let currentTick = DAMAGE_COOLDOWN_TICKS + 1;

    // P2 HP is 2. Apply 2 more damage.
    for (let i = 0; i < 2; i++) {
      currentTick += DAMAGE_COOLDOWN_TICKS + 1;
      const inputIx = buildSubmitInputIx(matchId, player1.publicKey, player1.publicKey, currentTick, 0, 0, true);
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(inputIx), [player1]);

      const dmgIx = buildApplyDamageIx(matchId, gameServer.publicKey, 2);
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(dmgIx), [gameServer]);
    }

    const endRoundIx = buildServerActionIx("end_round", matchId, gameServer.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(endRoundIx), [gameServer]);

    const [matchPda] = findMatchPda(matchId);
    const acct = await provider.connection.getAccountInfo(matchPda);
    const state = decodeMatchState(acct!.data);

    expect(state.player1RoundsWon).to.equal(1);
    expect(state.status).to.equal(3); // RoundEnd
    expect(state.currentRound).to.equal(2);
  });

  // ── 9. P1 wins round 2 → match complete ──────────────────────────────

  it("P1 wins round 2 → match complete", async () => {
    const startIx = buildServerActionIx("start_round", matchId, gameServer.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(startIx), [gameServer]);

    let currentTick = 200;
    for (let i = 0; i < HP_PER_ROUND; i++) {
      currentTick += DAMAGE_COOLDOWN_TICKS + 1;
      const inputIx = buildSubmitInputIx(matchId, player1.publicKey, player1.publicKey, currentTick, 0, 0, true);
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(inputIx), [player1]);

      const dmgIx = buildApplyDamageIx(matchId, gameServer.publicKey, 2);
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(dmgIx), [gameServer]);
    }

    const endRoundIx = buildServerActionIx("end_round", matchId, gameServer.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(endRoundIx), [gameServer]);

    const [matchPda] = findMatchPda(matchId);
    const acct = await provider.connection.getAccountInfo(matchPda);
    const state = decodeMatchState(acct!.data);

    expect(state.player1RoundsWon).to.equal(2);
    expect(state.status).to.equal(4); // Complete
    expect(state.winner.toBase58()).to.equal(player1.publicKey.toBase58());
    expect(state.settledAt).to.not.equal(BigInt(0));
  });

  // ── 10. Cancel match ──────────────────────────────────────────────────

  it("player1 can cancel a match before anyone joins", async () => {
    const cancelMatchId = matchId + 1;
    const createIx = buildCreateMatchIx(cancelMatchId, gameServer.publicKey, player1.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(createIx), [player1]);

    const cancelIx = buildCancelMatchIx(cancelMatchId, player1.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(cancelIx), [player1]);

    const [matchPda] = findMatchPda(cancelMatchId);
    const acct = await provider.connection.getAccountInfo(matchPda);
    expect(acct).to.be.null;
  });

  // ── 11. Forfeit ───────────────────────────────────────────────────────

  it("game server can forfeit a player", async () => {
    const forfeitMatchId = matchId + 2;

    const createIx = buildCreateMatchIx(forfeitMatchId, gameServer.publicKey, player1.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(createIx), [player1]);

    const joinIx = buildJoinMatchIx(forfeitMatchId, player2.publicKey, player2.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(joinIx), [player2]);

    const forfeitIx = buildForfeitIx(forfeitMatchId, gameServer.publicKey, 2);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(forfeitIx), [gameServer]);

    const [matchPda] = findMatchPda(forfeitMatchId);
    const acct = await provider.connection.getAccountInfo(matchPda);
    const state = decodeMatchState(acct!.data);

    expect(state.status).to.equal(4); // Complete
    expect(state.winner.toBase58()).to.equal(player1.publicKey.toBase58());
  });

  // ── 12. Cannot join own match ─────────────────────────────────────────

  it("player cannot join their own match", async () => {
    const selfMatchId = matchId + 3;
    const createIx = buildCreateMatchIx(selfMatchId, gameServer.publicKey, player1.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(createIx), [player1]);

    const joinIx = buildJoinMatchIx(selfMatchId, player1.publicKey, player1.publicKey);
    try {
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(joinIx), [player1]);
      expect.fail("Should have failed");
    } catch (err: any) {
      // Custom error for CannotJoinOwnMatch
      expect(err.toString()).to.include("0x1771");
    }
  });

  // ── 13. Close match rejects non-Complete match ──────────────────────

  it("close_match rejects WaitingForPlayer match", async () => {
    const closeTestId = matchId + 4;
    const createIx = buildCreateMatchIx(closeTestId, gameServer.publicKey, gameServer.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(createIx), [gameServer]);

    const closeIx = buildCloseMatchIx(closeTestId, gameServer.publicKey);
    try {
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(closeIx), [gameServer]);
      expect.fail("Should have failed with InvalidMatchState");
    } catch (err: any) {
      expect(err.toString()).to.include("Simulation failed");
    }

    // Clean up
    const cancelIx = buildCancelMatchIx(closeTestId, gameServer.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(cancelIx), [gameServer]);
  });

  // ── 14. Close match + player states after Complete ──────────────────

  it("game server closes player states then match after completion", async () => {
    // The main match (matchId) is Complete from test #9. Use it directly.
    const [matchPda] = findMatchPda(matchId);
    const [ps1Pda] = findPlayerStatePda(matchId, player1.publicKey);
    const [ps2Pda] = findPlayerStatePda(matchId, player2.publicKey);

    // Verify match is still there and Complete
    let matchAcct = await provider.connection.getAccountInfo(matchPda);
    expect(matchAcct).to.not.be.null;
    const state = decodeMatchState(matchAcct!.data);
    expect(state.status).to.equal(4); // Complete

    // Track balance before
    const balBefore = await provider.connection.getBalance(gameServer.publicKey);

    // Close player states first (reads arena_match for auth)
    const closePs1 = buildClosePlayerStateIx(matchId, player1.publicKey, gameServer.publicKey);
    const closePs2 = buildClosePlayerStateIx(matchId, player2.publicKey, gameServer.publicKey);
    const closeMatch = buildCloseMatchIx(matchId, gameServer.publicKey);

    // All three in one transaction
    const tx = new anchor.web3.Transaction().add(closePs1).add(closePs2).add(closeMatch);
    await provider.sendAndConfirm(tx, [gameServer]);

    // Verify all PDAs are gone
    const ps1After = await provider.connection.getAccountInfo(ps1Pda);
    const ps2After = await provider.connection.getAccountInfo(ps2Pda);
    const matchAfter = await provider.connection.getAccountInfo(matchPda);

    expect(ps1After).to.be.null;
    expect(ps2After).to.be.null;
    expect(matchAfter).to.be.null;

    // Verify rent was reclaimed (balance increased minus tx fee)
    const balAfter = await provider.connection.getBalance(gameServer.publicKey);
    expect(balAfter).to.be.greaterThan(balBefore - 10000); // Allow for tx fee
  });

  // ── 15. Close match after forfeit ───────────────────────────────────

  it("game server closes match after forfeit", async () => {
    // The forfeit match (matchId + 2) is Complete from test #11
    const forfeitMatchId = matchId + 2;
    const [matchPda] = findMatchPda(forfeitMatchId);

    let acct = await provider.connection.getAccountInfo(matchPda);
    expect(acct).to.not.be.null;

    const closeIx = buildCloseMatchIx(forfeitMatchId, gameServer.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(closeIx), [gameServer]);

    acct = await provider.connection.getAccountInfo(matchPda);
    expect(acct).to.be.null;
  });
});
