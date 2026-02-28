# Timebent Arena

[timebent.xyz](https://www.timebent.xyz/) | [𝕏 @TimebentGame](https://x.com/TimebentGame)

Solana Anchor program for Timebent - The Academy - an on-chain PVE and PVP arena, powered by [MagicBlock Ephemeral Rollups](https://docs.magicblock.gg/) for real-time gameplay.

This repo contains the smart contract only. It is **not** a deployable service — it compiles to a Solana BPF program and is deployed directly to the blockchain.

## Architecture

```
Game Client (Godot)
  |  WebSocket
  v
API Relay (timebent-api/matchRelay.ts) -- 20Hz tick loop
  |  Solana transactions
  v
This Program (arena_match) -- on MagicBlock ER validator
  |  Delegation / Commit
  v
Solana L1 (devnet / mainnet) -- persistent match results
```

The API relay (`timebent-api`) builds and submits transactions to this program via `erArenaTransactions.ts`. The game client never calls the program directly.

## Program ID

```
45A9Qb4YVeWwL35aBCTcT4bcfsgcFUW3GUHAbvhNJJGi
```

[View on Solscan (devnet)](https://solscan.io/account/45A9Qb4YVeWwL35aBCTcT4bcfsgcFUW3GUHAbvhNJJGi?cluster=devnet)

Anchor Program IDL published and available at the [Anchor Program IDL tab](https://solscan.io/account/45A9Qb4YVeWwL35aBCTcT4bcfsgcFUW3GUHAbvhNJJGi?cluster=devnet#anchorProgramIdl).

## Instructions

| # | Instruction | Signer | Where | Purpose |
|---|-------------|--------|-------|---------|
| 1 | `create_match` | game server | L1 | Create ArenaMatchState PDA |
| 2 | `join_match` | player2 (or session key) | ER | Player 2 joins, sets Countdown |
| 3 | `start_round` | game server | ER | Transition to Active, reset HP |
| 4 | `submit_input` | player (or session key) | ER | Player movement + attack input |
| 5 | `apply_damage` | game server | ER | Server-validated hit detection |
| 6 | `end_round` | game server | ER | Score round, advance or complete |
| 7 | `forfeit` | game server | ER | Forfeit a disconnected player |
| 8 | `delegate_match` | game server | L1 | Delegate match PDA to ER validator |
| 9 | `delegate_player_state` | game server | L1 | Delegate player state PDA to ER |
| 10 | `end_match` | game server | ER | Commit + undelegate back to L1 (no status check) |
| 11 | `create_player_state` | player | L1 | Create PlayerState PDA |
| 12 | `cancel_match` | player1 | L1 | Cancel before anyone joins (closes PDA) |
| 13 | `close_match` | game server | L1 | Close match PDA, reclaim rent (no status check) |
| 14 | `close_player_state` | game server | L1 | Close player state PDA, reclaim rent (no status check) |

### Derby Instructions

| # | Instruction | Signer | Where | Purpose |
|---|-------------|--------|-------|---------|
| D1 | `create_derby` | player | L1 | Create DerbyRaceState PDA |
| D2 | `delegate_derby` | game server | L1 | Delegate derby PDA to ER validator |
| D3 | `start_derby` | game server | ER | Start race (Created -> Racing) |
| D4 | `submit_derby_input` | player (or session key) | ER | Player movement input |
| D5 | `derby_server_update` | game server | ER | Server records collisions, pickups, checkpoints, laps, finish |
| D6 | `end_derby` | game server | ER | Commit + undelegate back to L1 |
| D7 | `close_derby` | game server | L1 | Close derby PDA, reclaim rent |

## Match Lifecycle

```
create_match (L1)
  -> delegate_match (L1 -> ER)
  -> join_match (ER)
  -> start_round (ER)
  -> [submit_input / apply_damage loop] (ER)
  -> end_round (ER)
  -> [repeat rounds until winner or max rounds]
  -> end_match (ER -> L1, commit + undelegate)
  -> close_player_state (L1, reclaim rent)
  -> close_match (L1, reclaim rent)
```

## Derby Lifecycle

```
create_derby (L1)
  -> delegate_derby (L1 -> ER)
  -> start_derby (ER)
  -> [submit_derby_input / derby_server_update loop] (ER)
  -> derby_server_update(FinishRace) (ER)
  -> end_derby (ER -> L1, commit + undelegate)
  -> close_derby (L1, reclaim rent)
```

## Account Types

### ArenaMatchState (PDA: `["arena_match", match_id_le_bytes]`)

| Field | Type | Description |
|-------|------|-------------|
| match_id | u64 | Unique match identifier |
| game_server | Pubkey | Authority for server-only actions |
| player1 | Pubkey | First player |
| player2 | Pubkey | Second player |
| status | MatchStatus | WaitingForPlayer / Countdown / Active / RoundEnd / Complete / Cancelled |
| current_round | u8 | Current round number (1-3) |
| player1_rounds_won | u8 | Rounds won by P1 |
| player2_rounds_won | u8 | Rounds won by P2 |
| player1_hp | u8 | P1 health this round (max 3) |
| player2_hp | u8 | P2 health this round (max 3) |
| current_tick | u32 | Latest tick received |
| round_start_tick | u32 | Tick when current round started |
| last_p1_damage_tick | u32 | Last tick P1 dealt damage |
| last_p2_damage_tick | u32 | Last tick P2 dealt damage |
| winner | Pubkey | Winner pubkey (default = draw) |
| created_at | i64 | Unix timestamp |
| settled_at | i64 | Unix timestamp when match completed |

### PlayerState (PDA: `["player_state", match_id_le_bytes, player_pubkey]`)

| Field | Type | Description |
|-------|------|-------------|
| match_id | u64 | Match this state belongs to |
| player | Pubkey | Player pubkey |
| dx | i8 | Horizontal input (-1, 0, 1) |
| dy | i8 | Vertical input (-1, 0, 1) |
| attacking | bool | Whether player is attacking |
| last_tick | u32 | Last input tick |
| input_count | u64 | Total inputs submitted |

### DerbyRaceState (PDA: `["derby_race", race_id_le_bytes]`)

| Field | Type | Description |
|-------|------|-------------|
| race_id | u64 | Unique race identifier |
| game_server | Pubkey | Authority for server-only actions |
| player | Pubkey | The racing player |
| vrf_seed | [u8; 32] | VRF seed for deterministic obstacle/item placement |
| status | DerbyStatus | Created / Racing / Finished / Cancelled |
| current_tick | u32 | Latest tick received |
| current_lap | u8 | Laps completed (0-3) |
| checkpoints_passed | u8 | Bitmask of checkpoints passed this lap (4 bits) |
| collisions | u16 | Total obstacle collisions |
| gold_collected | u8 | Total gold coins collected |
| boosts_collected | u8 | Total speed boosts collected |
| boost_end_tick | u32 | Tick when current boost expires |
| finish_tick | u32 | Tick when race finished |
| gold_bitmask | u16 | Which gold coins collected (15 bits) |
| boost_bitmask | u8 | Which boosts collected (8 bits) |
| created_at | i64 | Unix timestamp |
| settled_at | i64 | Unix timestamp when race finished |

## Game Constants

| Constant | Value | Description |
|----------|-------|-------------|
| MAX_ROUNDS | 3 | Best of 3 |
| WINS_NEEDED | 2 | First to 2 wins |
| HP_PER_ROUND | 3 | Health per round |
| ROUND_TICKS | 1200 | 60 seconds at 20Hz |
| DAMAGE_COOLDOWN_TICKS | 10 | ~500ms between hits |

### Derby Constants

| Constant | Value | Description |
|----------|-------|-------------|
| DERBY_MAX_LAPS | 3 | Laps to complete |
| DERBY_CHECKPOINT_COUNT | 4 | Checkpoints per lap |
| DERBY_MAX_OBSTACLES | 10 | Max obstacles on track |
| DERBY_MAX_BOOSTS | 8 | Max speed boosts on track |
| DERBY_MAX_GOLD | 15 | Max gold coins on track |
| DERBY_MAX_TICKS | 6000 | 5 minutes at 20Hz |
| DERBY_BOOST_DURATION_TICKS | 100 | 5 seconds at 20Hz |

### DerbyStatus

| Variant | Value | Description |
|---------|-------|-------------|
| Created | 0 | On L1, awaiting delegation |
| Racing | 1 | Active on ER |
| Finished | 2 | Race complete |
| Cancelled | 3 | Race cancelled |

### DerbyAction

| Variant | Fields | Description |
|---------|--------|-------------|
| RecordCollision | — | Player hit an obstacle |
| CollectGold | item_index: u8 | Collect gold coin (0-14) |
| CollectBoost | item_index: u8 | Collect speed boost (0-7) |
| PassCheckpoint | checkpoint_id: u8 | Pass checkpoint (0-3) |
| CompleteLap | — | Complete a lap (requires all 4 checkpoints) |
| FinishRace | — | Finish race (requires 3 laps complete) |

### DerbyError

| Code | Name | Description |
|------|------|-------------|
| 6010 | InvalidDerbyState | Wrong status for this action |
| 6011 | RaceNotActive | Race is not in Racing status |
| 6012 | RaceNotFinished | Race is not Finished or Cancelled |
| 6013 | RaceTimedOut | Input tick exceeds DERBY_MAX_TICKS |
| 6014 | InvalidItemIndex | Item index out of range |
| 6015 | ItemAlreadyCollected | Gold/boost already collected |
| 6016 | InvalidCheckpoint | Checkpoint ID out of range |
| 6017 | MissingCheckpoints | Not all checkpoints passed for lap |
| 6018 | LapsNotComplete | Not all 3 laps complete for finish |
| 6019 | UnauthorizedServer | Signer is not the game server |

> **Note:** Anchor assigns each `#[error_code]` enum codes starting from 6000 independently. The actual program emits 6000-6009 for DerbyError (same range as ArenaError). The IDL uses 6010-6019 to avoid duplicate code numbers. Match errors by name, not code.

## Dependencies

| Crate | Version | Purpose |
|-------|---------|---------|
| anchor-lang | 0.32.1 | Solana framework |
| ephemeral-rollups-sdk | 0.8.0 | MagicBlock ER delegation/commit |
| session-keys | 3.0.10 | Session key authentication |

## Development

### Prerequisites

- Rust 1.85+
- Anchor CLI 0.32.1
- Solana CLI 2.1+

### Build

```bash
# Build (skip IDL generation due to anchor-syn bug on current Rust)
anchor build --no-idl
```

> **Note:** `anchor idl build` fails with a `Span::local_file()` error due to an anchor-syn 0.32.1 bug. The IDL is maintained manually in `target/idl/arena_match.json` and published with `anchor idl init` / `anchor idl upgrade`.

### Deploy

```bash
# Deploy to devnet
anchor deploy --provider.cluster devnet --provider.wallet ~/.config/solana/id.json

# Verify
solana program show 45A9Qb4YVeWwL35aBCTcT4bcfsgcFUW3GUHAbvhNJJGi --url devnet
```

### Test

```bash
# Run E2E tests against devnet
anchor test --provider.cluster devnet --skip-deploy --skip-build
```

Tests cover: match creation, player state creation, joining, round flow (input, damage, cooldown enforcement), round completion, match completion, cancellation, forfeit, close/rent reclamation, derby race creation, start, input, collisions, gold/boost collection, checkpoints, lap completion, full 3-lap race, and error cases.

### Update IDL on-chain

```bash
# After modifying the IDL file
anchor idl upgrade --filepath target/idl/arena_match.json --provider.cluster devnet 45A9Qb4YVeWwL35aBCTcT4bcfsgcFUW3GUHAbvhNJJGi
```

## Design Notes

### Server-Trusted Authority Model

The API relay (`timebent-api/matchRelay.ts`) is the authoritative game server — it drives the 20Hz tick loop, validates damage, and determines round/match winners. The on-chain program records state for verifiability but does **not** enforce match outcome logic.

All ER game action transactions (`erStartRound`, `erApplyDamage`, `erEndRound`) are sent **fire-and-forget** from the relay to maximize game loop performance. This means on-chain state may lag behind the relay's in-memory state at any given moment.

Because of this:

- **`end_match`** does not check `status == Complete`. The game server is authenticated via signer constraint and is trusted to decide when to settle. If we required `Complete`, the settlement would fail whenever fire-and-forget round-end transactions hadn't been confirmed on ER yet.
- **`close_match` / `close_player_state`** do not check match status. The game server can close PDAs at any time after settlement to reclaim rent (~0.002 SOL per match).

### ER Settlement Flow

The `end_match` instruction uses the `#[commit]` macro which injects `magic_program` and `magic_context` accounts. Internally it calls `commit_and_undelegate_accounts` as a **CPI** to the MagicBlock Magic Program. This must be a CPI (not a top-level instruction) because the Magic Program needs to detect the parent program ID from the call stack.

On the TypeScript side, the `#[commit]` macro injects accounts in this order:
1. `magic_program` (`Magic11111111111111111111111111111111111111`)
2. `magic_context` (`MagicContext1111111111111111111111111111111`)

After `end_match` confirms on ER, the relay calls `GetCommitmentSignature()` from `@magicblock-labs/ephemeral-rollups-sdk` to await the L1 commitment signature. This parses the `"ScheduledCommitSent signature: ..."` log from the Magic Program's CPI response and waits for the corresponding L1 transaction to confirm.

### ER Validator

| Network | Validator | Endpoint |
|---------|-----------|----------|
| Devnet | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` | `https://devnet-us.magicblock.app/` |

### Match PDA Lifecycle on L1

```
create_match   -> PDA created, owned by arena program
delegate_match -> PDA ownership transfers to DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh
  [match plays on ER]
end_match      -> commit + undelegate, PDA ownership returns to arena program
close_match    -> PDA closed, rent returned to game server
```

## Key Files

| File | Purpose |
|------|---------|
| `programs/arena-match/src/lib.rs` | Program source (instructions, accounts, constraints) |
| `target/idl/arena_match.json` | Manually maintained IDL (published on-chain) |
| `tests/arena_match.ts` | Arena E2E tests |
| `tests/derby_race.ts` | Derby E2E tests |
| `keys/arena-match-keypair.json` | Program deploy keypair |
| `Anchor.toml` | Anchor configuration |

## Related Repos

| Repo | Role |
|------|------|
| `timebent-api` | Relay server — WebSocket match loop, `erArenaTransactions.ts` builds + sends txs to this program |
| `timebent-oracle` | Match history API — records results in MongoDB |
| `timebent-game` | Game client — renders arena, sends player input over WebSocket |
