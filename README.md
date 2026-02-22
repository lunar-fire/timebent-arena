# Timebent Arena

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
| 10 | `end_match` | game server | ER | Commit + undelegate back to L1 |
| 11 | `create_player_state` | player | L1 | Create PlayerState PDA |
| 12 | `cancel_match` | player1 | L1 | Cancel before anyone joins (closes PDA) |
| 13 | `close_match` | game server | L1 | Close match PDA after Complete/Cancelled, reclaim rent |
| 14 | `close_player_state` | game server | L1 | Close player state PDA, reclaim rent |

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

## Game Constants

| Constant | Value | Description |
|----------|-------|-------------|
| MAX_ROUNDS | 3 | Best of 3 |
| WINS_NEEDED | 2 | First to 2 wins |
| HP_PER_ROUND | 3 | Health per round |
| ROUND_TICKS | 1200 | 60 seconds at 20Hz |
| DAMAGE_COOLDOWN_TICKS | 10 | ~500ms between hits |

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

Tests cover: match creation, player state creation, joining, round flow (input, damage, cooldown enforcement), round completion, match completion, cancellation, forfeit, close/rent reclamation, and error cases.

### Update IDL on-chain

```bash
# After modifying the IDL file
anchor idl upgrade --filepath target/idl/arena_match.json --provider.cluster devnet 45A9Qb4YVeWwL35aBCTcT4bcfsgcFUW3GUHAbvhNJJGi
```

## Key Files

| File | Purpose |
|------|---------|
| `programs/arena-match/src/lib.rs` | Program source (instructions, accounts, constraints) |
| `target/idl/arena_match.json` | Manually maintained IDL (published on-chain) |
| `tests/arena_match.ts` | E2E tests |
| `keys/arena-match-keypair.json` | Program deploy keypair |
| `Anchor.toml` | Anchor configuration |

## Related Repos

| Repo | Role |
|------|------|
| `timebent-api` | Relay server — WebSocket match loop, `erArenaTransactions.ts` builds + sends txs to this program |
| `timebent-oracle` | Match history API — records results in MongoDB |
| `timebent-game` | Game client — renders arena, sends player input over WebSocket |
