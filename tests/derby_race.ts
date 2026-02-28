import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { createHash } from "crypto";

// Program ID
const PROGRAM_ID = new PublicKey("45A9Qb4YVeWwL35aBCTcT4bcfsgcFUW3GUHAbvhNJJGi");

// Seeds
const DERBY_SEED = Buffer.from("derby_race");

// Derby constants (must match program)
const DERBY_MAX_LAPS = 3;
const DERBY_CHECKPOINT_COUNT = 4;
const DERBY_MAX_TICKS = 6000;
const DERBY_BOOST_DURATION_TICKS = 100;

// ── Helpers ─────────────────────────────────────────────────────────────────

function raceIdToBytes(raceId: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(raceId));
  return buf;
}

function findDerbyPda(raceId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DERBY_SEED, raceIdToBytes(raceId)],
    PROGRAM_ID
  );
}

// ── Account Deserialization ─────────────────────────────────────────────────

interface DerbyRaceStateData {
  raceId: bigint;
  gameServer: PublicKey;
  player: PublicKey;
  vrfSeed: Uint8Array;
  status: number;
  currentTick: number;
  currentLap: number;
  checkpointsPassed: number;
  collisions: number;
  goldCollected: number;
  boostsCollected: number;
  boostEndTick: number;
  finishTick: number;
  goldBitmask: number;
  boostBitmask: number;
  createdAt: bigint;
  settledAt: bigint;
}

function decodeDerbyRaceState(data: Buffer): DerbyRaceStateData {
  let offset = 8; // discriminator
  const raceId = data.readBigUInt64LE(offset); offset += 8;
  const gameServer = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const player = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const vrfSeed = data.subarray(offset, offset + 32); offset += 32;
  const status = data.readUInt8(offset); offset += 1;
  const currentTick = data.readUInt32LE(offset); offset += 4;
  const currentLap = data.readUInt8(offset); offset += 1;
  const checkpointsPassed = data.readUInt8(offset); offset += 1;
  const collisions = data.readUInt16LE(offset); offset += 2;
  const goldCollected = data.readUInt8(offset); offset += 1;
  const boostsCollected = data.readUInt8(offset); offset += 1;
  const boostEndTick = data.readUInt32LE(offset); offset += 4;
  const finishTick = data.readUInt32LE(offset); offset += 4;
  const goldBitmask = data.readUInt16LE(offset); offset += 2;
  const boostBitmask = data.readUInt8(offset); offset += 1;
  const createdAt = data.readBigInt64LE(offset); offset += 8;
  const settledAt = data.readBigInt64LE(offset);
  return {
    raceId, gameServer, player, vrfSeed, status, currentTick, currentLap,
    checkpointsPassed, collisions, goldCollected, boostsCollected,
    boostEndTick, finishTick, goldBitmask, boostBitmask, createdAt, settledAt,
  };
}

// ── Instruction Builders ────────────────────────────────────────────────────

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function buildCreateDerbyIx(
  raceId: number,
  gameServer: PublicKey,
  player: PublicKey,
  vrfSeed: Buffer,
): anchor.web3.TransactionInstruction {
  const [derbyPda] = findDerbyPda(raceId);
  const raceIdBuf = Buffer.alloc(8);
  raceIdBuf.writeBigUInt64LE(BigInt(raceId));
  const data = Buffer.concat([disc("create_derby"), raceIdBuf, vrfSeed]);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: derbyPda, isSigner: false, isWritable: true },
      { pubkey: gameServer, isSigner: false, isWritable: false },
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildDerbyServerActionIx(
  instructionName: string,
  raceId: number,
  gameServer: PublicKey,
  extraData?: Buffer,
): anchor.web3.TransactionInstruction {
  const [derbyPda] = findDerbyPda(raceId);
  const raceIdBuf = Buffer.alloc(8);
  raceIdBuf.writeBigUInt64LE(BigInt(raceId));
  const data = Buffer.concat([disc(instructionName), raceIdBuf, ...(extraData ? [extraData] : [])]);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: derbyPda, isSigner: false, isWritable: true },
      { pubkey: gameServer, isSigner: true, isWritable: true },
    ],
    data,
  });
}

function encodeDerbyAction(action:
  | { type: "RecordCollision" }
  | { type: "CollectGold"; itemIndex: number }
  | { type: "CollectBoost"; itemIndex: number }
  | { type: "PassCheckpoint"; checkpointId: number }
  | { type: "CompleteLap" }
  | { type: "FinishRace" }
): Buffer {
  switch (action.type) {
    case "RecordCollision":
      return Buffer.from([0]);
    case "CollectGold":
      return Buffer.from([1, action.itemIndex]);
    case "CollectBoost":
      return Buffer.from([2, action.itemIndex]);
    case "PassCheckpoint":
      return Buffer.from([3, action.checkpointId]);
    case "CompleteLap":
      return Buffer.from([4]);
    case "FinishRace":
      return Buffer.from([5]);
  }
}

function buildDerbyServerUpdateIx(
  raceId: number,
  gameServer: PublicKey,
  action: Parameters<typeof encodeDerbyAction>[0],
): anchor.web3.TransactionInstruction {
  return buildDerbyServerActionIx(
    "derby_server_update",
    raceId,
    gameServer,
    encodeDerbyAction(action),
  );
}

function buildSubmitDerbyInputIx(
  raceId: number,
  player: PublicKey,
  payer: PublicKey,
  tick: number,
  dx: number,
  dy: number,
): anchor.web3.TransactionInstruction {
  const [derbyPda] = findDerbyPda(raceId);

  const argsBuf = Buffer.alloc(8 + 4 + 1 + 1);
  let off = 0;
  argsBuf.writeBigUInt64LE(BigInt(raceId), off); off += 8;
  argsBuf.writeUInt32LE(tick, off); off += 4;
  argsBuf.writeInt8(dx, off); off += 1;
  argsBuf.writeInt8(dy, off);
  const data = Buffer.concat([disc("submit_derby_input"), argsBuf]);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: derbyPda, isSigner: false, isWritable: true },
      { pubkey: player, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      // session_token = None — pass program ID as placeholder
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// Helper: pass all 4 checkpoints then complete lap
async function passAllCheckpointsAndCompleteLap(
  provider: anchor.AnchorProvider,
  raceId: number,
  gameServer: Keypair,
): Promise<void> {
  for (let cp = 0; cp < DERBY_CHECKPOINT_COUNT; cp++) {
    const ix = buildDerbyServerUpdateIx(raceId, gameServer.publicKey, {
      type: "PassCheckpoint",
      checkpointId: cp,
    });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);
  }
  const lapIx = buildDerbyServerUpdateIx(raceId, gameServer.publicKey, { type: "CompleteLap" });
  await provider.sendAndConfirm(new anchor.web3.Transaction().add(lapIx), [gameServer]);
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("derby-race", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Use provider wallet as "game server" for testing
  const gameServer = (provider.wallet as anchor.Wallet).payer;
  const player = Keypair.generate();

  let raceId: number;
  const vrfSeed = Buffer.alloc(32);
  createHash("sha256").update("test-vrf-seed").digest().copy(vrfSeed);

  before(async () => {
    raceId = Math.floor(Math.random() * 1_000_000);

    // Fund player via SystemProgram.transfer (avoids faucet rate limits)
    const transferIx = SystemProgram.transfer({
      fromPubkey: gameServer.publicKey,
      toPubkey: player.publicKey,
      lamports: 5 * anchor.web3.LAMPORTS_PER_SOL,
    });
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(transferIx),
      [gameServer]
    );
  });

  // ── 1. Create derby race ────────────────────────────────────────────────

  it("creates a derby race", async () => {
    const ix = buildCreateDerbyIx(raceId, gameServer.publicKey, player.publicKey, vrfSeed);
    const tx = new anchor.web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [player]);

    const [derbyPda] = findDerbyPda(raceId);
    const acct = await provider.connection.getAccountInfo(derbyPda);
    expect(acct).to.not.be.null;

    const state = decodeDerbyRaceState(acct!.data);
    expect(state.raceId).to.equal(BigInt(raceId));
    expect(state.gameServer.toBase58()).to.equal(gameServer.publicKey.toBase58());
    expect(state.player.toBase58()).to.equal(player.publicKey.toBase58());
    expect(Buffer.from(state.vrfSeed).equals(vrfSeed)).to.be.true;
    expect(state.status).to.equal(0); // Created
    expect(state.currentTick).to.equal(0);
    expect(state.currentLap).to.equal(0);
    expect(state.checkpointsPassed).to.equal(0);
    expect(state.collisions).to.equal(0);
    expect(state.goldCollected).to.equal(0);
    expect(state.boostsCollected).to.equal(0);
    expect(state.createdAt).to.not.equal(BigInt(0));
    expect(state.settledAt).to.equal(BigInt(0));
  });

  // ── 2. Start the race ──────────────────────────────────────────────────

  it("game server starts the race", async () => {
    const ix = buildDerbyServerActionIx("start_derby", raceId, gameServer.publicKey);
    const tx = new anchor.web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [gameServer]);

    const [derbyPda] = findDerbyPda(raceId);
    const acct = await provider.connection.getAccountInfo(derbyPda);
    const state = decodeDerbyRaceState(acct!.data);

    expect(state.status).to.equal(1); // Racing
    expect(state.currentTick).to.equal(0);
    expect(state.currentLap).to.equal(0);
    expect(state.checkpointsPassed).to.equal(0);
  });

  // ── 3. Reject starting an already-racing derby ─────────────────────────

  it("rejects starting an already-racing derby", async () => {
    const ix = buildDerbyServerActionIx("start_derby", raceId, gameServer.publicKey);
    try {
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);
      expect.fail("Should have failed with InvalidDerbyState");
    } catch (err: any) {
      // DerbyError::InvalidDerbyState = 6000 = 0x1770
      expect(err.toString()).to.include("0x1770");
    }
  });

  // ── 4. Player submits input ────────────────────────────────────────────

  it("player submits input", async () => {
    const ix = buildSubmitDerbyInputIx(raceId, player.publicKey, player.publicKey, 100, 1, -1);
    const tx = new anchor.web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [player]);

    const [derbyPda] = findDerbyPda(raceId);
    const acct = await provider.connection.getAccountInfo(derbyPda);
    const state = decodeDerbyRaceState(acct!.data);

    expect(state.currentTick).to.equal(100);
  });

  // ── 5. Reject input past max ticks ─────────────────────────────────────

  it("rejects input past max ticks", async () => {
    const ix = buildSubmitDerbyInputIx(raceId, player.publicKey, player.publicKey, DERBY_MAX_TICKS + 1, 0, 0);
    try {
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [player]);
      expect.fail("Should have failed with RaceTimedOut");
    } catch (err: any) {
      // DerbyError::RaceTimedOut = 6003 = 0x1773
      expect(err.toString()).to.include("0x1773");
    }
  });

  // ── 6. Server records collision ────────────────────────────────────────

  it("server records collision", async () => {
    const ix = buildDerbyServerUpdateIx(raceId, gameServer.publicKey, { type: "RecordCollision" });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);

    const [derbyPda] = findDerbyPda(raceId);
    const acct = await provider.connection.getAccountInfo(derbyPda);
    const state = decodeDerbyRaceState(acct!.data);

    expect(state.collisions).to.equal(1);
  });

  // ── 7. Server collects gold (index 0) ──────────────────────────────────

  it("server collects gold (index 0)", async () => {
    const ix = buildDerbyServerUpdateIx(raceId, gameServer.publicKey, { type: "CollectGold", itemIndex: 0 });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);

    const [derbyPda] = findDerbyPda(raceId);
    const acct = await provider.connection.getAccountInfo(derbyPda);
    const state = decodeDerbyRaceState(acct!.data);

    expect(state.goldCollected).to.equal(1);
    expect(state.goldBitmask & 1).to.equal(1); // bit 0 set
  });

  // ── 8. Reject double gold collection (index 0) ─────────────────────────

  it("rejects double gold collection (index 0)", async () => {
    const ix = buildDerbyServerUpdateIx(raceId, gameServer.publicKey, { type: "CollectGold", itemIndex: 0 });
    try {
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);
      expect.fail("Should have failed with ItemAlreadyCollected");
    } catch (err: any) {
      // DerbyError::ItemAlreadyCollected = 6005 = 0x1775
      expect(err.toString()).to.include("0x1775");
    }
  });

  // ── 9. Reject invalid gold index (15) ──────────────────────────────────

  it("rejects invalid gold index (15)", async () => {
    const ix = buildDerbyServerUpdateIx(raceId, gameServer.publicKey, { type: "CollectGold", itemIndex: 15 });
    try {
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);
      expect.fail("Should have failed with InvalidItemIndex");
    } catch (err: any) {
      // DerbyError::InvalidItemIndex = 6004 = 0x1774
      expect(err.toString()).to.include("0x1774");
    }
  });

  // ── 10. Server collects boost (index 0) ────────────────────────────────

  it("server collects boost (index 0)", async () => {
    const ix = buildDerbyServerUpdateIx(raceId, gameServer.publicKey, { type: "CollectBoost", itemIndex: 0 });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);

    const [derbyPda] = findDerbyPda(raceId);
    const acct = await provider.connection.getAccountInfo(derbyPda);
    const state = decodeDerbyRaceState(acct!.data);

    expect(state.boostsCollected).to.equal(1);
    expect(state.boostBitmask & 1).to.equal(1); // bit 0 set
    expect(state.boostEndTick).to.equal(100 + DERBY_BOOST_DURATION_TICKS); // current_tick(100) + boost duration
  });

  // ── 11. Server passes all 4 checkpoints ────────────────────────────────

  it("server passes all 4 checkpoints", async () => {
    for (let cp = 0; cp < DERBY_CHECKPOINT_COUNT; cp++) {
      const ix = buildDerbyServerUpdateIx(raceId, gameServer.publicKey, {
        type: "PassCheckpoint",
        checkpointId: cp,
      });
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);
    }

    const [derbyPda] = findDerbyPda(raceId);
    const acct = await provider.connection.getAccountInfo(derbyPda);
    const state = decodeDerbyRaceState(acct!.data);

    const allCheckpoints = (1 << DERBY_CHECKPOINT_COUNT) - 1; // 0b1111 = 15
    expect(state.checkpointsPassed).to.equal(allCheckpoints);
  });

  // ── 12. Server completes lap 1 ─────────────────────────────────────────

  it("server completes lap 1", async () => {
    const ix = buildDerbyServerUpdateIx(raceId, gameServer.publicKey, { type: "CompleteLap" });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);

    const [derbyPda] = findDerbyPda(raceId);
    const acct = await provider.connection.getAccountInfo(derbyPda);
    const state = decodeDerbyRaceState(acct!.data);

    expect(state.currentLap).to.equal(1);
    expect(state.checkpointsPassed).to.equal(0); // reset for next lap
  });

  // ── 13. Reject lap completion without checkpoints ──────────────────────

  it("rejects lap completion without checkpoints", async () => {
    const ix = buildDerbyServerUpdateIx(raceId, gameServer.publicKey, { type: "CompleteLap" });
    try {
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);
      expect.fail("Should have failed with MissingCheckpoints");
    } catch (err: any) {
      // DerbyError::MissingCheckpoints = 6007 = 0x1777
      expect(err.toString()).to.include("0x1777");
    }
  });

  // ── 14. Full race — 3 laps and finish ──────────────────────────────────

  it("completes full race — 3 laps and finish", async () => {
    // Lap 1 already done in test 12. Complete laps 2 and 3.
    await passAllCheckpointsAndCompleteLap(provider, raceId, gameServer);
    await passAllCheckpointsAndCompleteLap(provider, raceId, gameServer);

    // Verify current_lap = 3 before finishing
    const [derbyPda] = findDerbyPda(raceId);
    let acct = await provider.connection.getAccountInfo(derbyPda);
    let state = decodeDerbyRaceState(acct!.data);
    expect(state.currentLap).to.equal(3);

    // Finish the race
    const finishIx = buildDerbyServerUpdateIx(raceId, gameServer.publicKey, { type: "FinishRace" });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(finishIx), [gameServer]);

    acct = await provider.connection.getAccountInfo(derbyPda);
    state = decodeDerbyRaceState(acct!.data);

    expect(state.status).to.equal(2); // Finished
    expect(state.finishTick).to.equal(100); // current_tick was set to 100 in test 4
    expect(state.settledAt).to.not.equal(BigInt(0));
  });

  // ── 15. Reject finish without enough laps ──────────────────────────────

  it("rejects finish without enough laps", async () => {
    // Create and start a new race
    const newRaceId = raceId + 1;
    const createIx = buildCreateDerbyIx(newRaceId, gameServer.publicKey, player.publicKey, vrfSeed);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(createIx), [player]);

    const startIx = buildDerbyServerActionIx("start_derby", newRaceId, gameServer.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(startIx), [gameServer]);

    // Try to finish immediately — no laps completed
    const finishIx = buildDerbyServerUpdateIx(newRaceId, gameServer.publicKey, { type: "FinishRace" });
    try {
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(finishIx), [gameServer]);
      expect.fail("Should have failed with LapsNotComplete");
    } catch (err: any) {
      // DerbyError::LapsNotComplete = 6008 = 0x1778
      expect(err.toString()).to.include("0x1778");
    }
  });

  // ── 16. Reject server update on non-racing derby ───────────────────────

  it("rejects server update on non-racing derby", async () => {
    // Create a new race but do NOT start it
    const newRaceId = raceId + 2;
    const createIx = buildCreateDerbyIx(newRaceId, gameServer.publicKey, player.publicKey, vrfSeed);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(createIx), [player]);

    // Try RecordCollision on a Created (not Racing) derby
    const ix = buildDerbyServerUpdateIx(newRaceId, gameServer.publicKey, { type: "RecordCollision" });
    try {
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [gameServer]);
      expect.fail("Should have failed with RaceNotActive");
    } catch (err: any) {
      // DerbyError::RaceNotActive = 6001 = 0x1771
      expect(err.toString()).to.include("0x1771");
    }
  });
});
