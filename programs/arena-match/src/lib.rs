use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;
use session_keys::{session_auth_or, Session, SessionError, SessionToken};

declare_id!("45A9Qb4YVeWwL35aBCTcT4bcfsgcFUW3GUHAbvhNJJGi");

// ── Seeds ───────────────────────────────────────────────────────────────────
pub const MATCH_SEED: &[u8] = b"arena_match";
pub const PLAYER_STATE_SEED: &[u8] = b"player_state";

// ── Game Constants (mirror MATCH_CONFIG from TypeScript relay) ──────────────
pub const MAX_ROUNDS: u8 = 3;
pub const WINS_NEEDED: u8 = 2;
pub const HP_PER_ROUND: u8 = 3;
pub const ROUND_TICKS: u32 = 1200; // 60s × 20Hz
pub const DAMAGE_COOLDOWN_TICKS: u32 = 10; // ~500ms between hits
pub const MAX_DAMAGE_PER_HIT: u8 = 1;

// ── Derby Seeds ──────────────────────────────────────────────────────────
pub const DERBY_SEED: &[u8] = b"derby_race";
pub const DERBY_PLAYER_SEED: &[u8] = b"derby_player";

// ── Derby Constants ──────────────────────────────────────────────────────
pub const DERBY_MAX_LAPS: u8 = 3;
pub const DERBY_CHECKPOINT_COUNT: u8 = 4;
pub const DERBY_MAX_OBSTACLES: u8 = 10;
pub const DERBY_MAX_BOOSTS: u8 = 8;
pub const DERBY_MAX_GOLD: u8 = 15;
pub const DERBY_MAX_TICKS: u32 = 6000; // 5min at 20Hz
pub const DERBY_BOOST_DURATION_TICKS: u32 = 100; // 5s at 20Hz

// ═══════════════════════════════════════════════════════════════════════════
// PROGRAM
// ═══════════════════════════════════════════════════════════════════════════

#[ephemeral]
#[program]
pub mod arena_match {
    use super::*;

    // ── 1. Create match (on L1) ────────────────────────────────────────────
    pub fn create_match(ctx: Context<CreateMatch>, match_id: u64) -> Result<()> {
        let m = &mut ctx.accounts.arena_match;
        m.match_id = match_id;
        m.game_server = ctx.accounts.game_server.key();
        m.player1 = ctx.accounts.player1.key();
        m.player2 = Pubkey::default();
        m.status = MatchStatus::WaitingForPlayer;
        m.current_round = 0;
        m.player1_rounds_won = 0;
        m.player2_rounds_won = 0;
        m.player1_hp = HP_PER_ROUND;
        m.player2_hp = HP_PER_ROUND;
        m.current_tick = 0;
        m.round_start_tick = 0;
        m.last_p1_damage_tick = 0;
        m.last_p2_damage_tick = 0;
        m.winner = Pubkey::default();
        m.created_at = Clock::get()?.unix_timestamp;
        m.settled_at = 0;
        msg!("Match {} created by {} (server: {})", match_id, m.player1, m.game_server);
        Ok(())
    }

    // ── 2. Join match (on ER after delegation) ─────────────────────────────
    #[session_auth_or(
        ctx.accounts.payer.key() == ctx.accounts.player2.key(),
        SessionError::InvalidToken
    )]
    pub fn join_match(ctx: Context<JoinMatch>, _match_id: u64) -> Result<()> {
        let m = &mut ctx.accounts.arena_match;
        let p2 = ctx.accounts.player2.key();
        require!(m.status == MatchStatus::WaitingForPlayer, ArenaError::MatchNotJoinable);
        require!(m.player1 != p2, ArenaError::CannotJoinOwnMatch);

        m.player2 = p2;
        m.status = MatchStatus::Countdown;
        m.current_round = 1;
        m.current_tick = 0;
        m.round_start_tick = 0;
        m.player1_hp = HP_PER_ROUND;
        m.player2_hp = HP_PER_ROUND;
        msg!("Player {} joined match {}", p2, m.match_id);
        Ok(())
    }

    // ── 3. Start round (server only, on ER) ────────────────────────────────
    pub fn start_round(ctx: Context<ServerAction>, _match_id: u64) -> Result<()> {
        let m = &mut ctx.accounts.arena_match;
        require!(
            m.status == MatchStatus::Countdown || m.status == MatchStatus::RoundEnd,
            ArenaError::InvalidMatchState
        );
        m.status = MatchStatus::Active;
        m.round_start_tick = m.current_tick;
        m.player1_hp = HP_PER_ROUND;
        m.player2_hp = HP_PER_ROUND;
        m.last_p1_damage_tick = 0;
        m.last_p2_damage_tick = 0;
        msg!("Round {} started at tick {}", m.current_round, m.current_tick);
        Ok(())
    }

    // ── 4. Submit input (on ER, fast) ──────────────────────────────────────
    #[session_auth_or(
        ctx.accounts.payer.key() == ctx.accounts.player.key(),
        SessionError::InvalidToken
    )]
    pub fn submit_input(
        ctx: Context<SubmitInput>,
        _match_id: u64,
        tick: u32,
        dx: i8,
        dy: i8,
        attacking: bool,
    ) -> Result<()> {
        let m = &mut ctx.accounts.arena_match;
        let ps = &mut ctx.accounts.player_state;

        require!(m.status == MatchStatus::Active, ArenaError::MatchNotActive);

        // Update player state
        ps.last_tick = tick;
        ps.dx = dx;
        ps.dy = dy;
        ps.attacking = attacking;
        ps.input_count += 1;

        // Advance match tick to latest
        if tick > m.current_tick {
            m.current_tick = tick;
        }

        // Check round timeout
        let ticks_elapsed = m.current_tick.saturating_sub(m.round_start_tick);
        if ticks_elapsed >= ROUND_TICKS {
            msg!("Round {} timed out at tick {}", m.current_round, m.current_tick);
        }

        Ok(())
    }

    // ── 5. Apply damage (server-validated, on ER) ──────────────────────────
    pub fn apply_damage(
        ctx: Context<ServerAction>,
        _match_id: u64,
        target_slot: u8, // 1 = player1, 2 = player2
    ) -> Result<()> {
        let m = &mut ctx.accounts.arena_match;
        require!(m.status == MatchStatus::Active, ArenaError::MatchNotActive);

        match target_slot {
            1 => {
                let cooldown_ok = m.current_tick.saturating_sub(m.last_p2_damage_tick) >= DAMAGE_COOLDOWN_TICKS;
                require!(cooldown_ok, ArenaError::DamageCooldown);
                m.player1_hp = m.player1_hp.saturating_sub(MAX_DAMAGE_PER_HIT);
                m.last_p2_damage_tick = m.current_tick;
                msg!("P1 hit! HP: {}", m.player1_hp);
            }
            2 => {
                let cooldown_ok = m.current_tick.saturating_sub(m.last_p1_damage_tick) >= DAMAGE_COOLDOWN_TICKS;
                require!(cooldown_ok, ArenaError::DamageCooldown);
                m.player2_hp = m.player2_hp.saturating_sub(MAX_DAMAGE_PER_HIT);
                m.last_p1_damage_tick = m.current_tick;
                msg!("P2 hit! HP: {}", m.player2_hp);
            }
            _ => return Err(ArenaError::InvalidTargetSlot.into()),
        }

        Ok(())
    }

    // ── 6. End round (server only, on ER) ──────────────────────────────────
    pub fn end_round(ctx: Context<ServerAction>, _match_id: u64) -> Result<()> {
        let m = &mut ctx.accounts.arena_match;
        require!(m.status == MatchStatus::Active, ArenaError::MatchNotActive);

        if m.player1_hp > m.player2_hp {
            m.player1_rounds_won += 1;
            msg!("Round {} won by P1", m.current_round);
        } else if m.player2_hp > m.player1_hp {
            m.player2_rounds_won += 1;
            msg!("Round {} won by P2", m.current_round);
        } else {
            msg!("Round {} draw", m.current_round);
        }

        if m.player1_rounds_won >= WINS_NEEDED {
            m.status = MatchStatus::Complete;
            m.winner = m.player1;
            m.settled_at = Clock::get()?.unix_timestamp;
            msg!("Match complete! Winner: P1 ({})", m.player1);
        } else if m.player2_rounds_won >= WINS_NEEDED {
            m.status = MatchStatus::Complete;
            m.winner = m.player2;
            m.settled_at = Clock::get()?.unix_timestamp;
            msg!("Match complete! Winner: P2 ({})", m.player2);
        } else if m.current_round >= MAX_ROUNDS {
            m.status = MatchStatus::Complete;
            m.winner = Pubkey::default();
            m.settled_at = Clock::get()?.unix_timestamp;
            msg!("Match complete! Draw.");
        } else {
            m.status = MatchStatus::RoundEnd;
            m.current_round += 1;
            msg!("Advancing to round {}", m.current_round);
        }

        Ok(())
    }

    // ── 7. Forfeit (player disconnected / timed out) ───────────────────────
    pub fn forfeit(ctx: Context<ServerAction>, _match_id: u64, forfeiter_slot: u8) -> Result<()> {
        let m = &mut ctx.accounts.arena_match;
        require!(
            m.status == MatchStatus::Active || m.status == MatchStatus::Countdown || m.status == MatchStatus::RoundEnd,
            ArenaError::InvalidMatchState
        );

        match forfeiter_slot {
            1 => {
                m.winner = m.player2;
                msg!("P1 forfeited. Winner: P2 ({})", m.player2);
            }
            2 => {
                m.winner = m.player1;
                msg!("P2 forfeited. Winner: P1 ({})", m.player1);
            }
            _ => return Err(ArenaError::InvalidTargetSlot.into()),
        }

        m.status = MatchStatus::Complete;
        m.settled_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    // ── 8. Delegate match to ER ────────────────────────────────────────────
    pub fn delegate_match(ctx: Context<DelegateMatch>, match_id: u64) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[MATCH_SEED, &match_id.to_le_bytes()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        msg!("Match {} delegated to ER", match_id);
        Ok(())
    }

    // ── 9. Delegate player state to ER ─────────────────────────────────────
    pub fn delegate_player_state(ctx: Context<DelegatePlayerState>, match_id: u64, player: Pubkey) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[
                PLAYER_STATE_SEED,
                &match_id.to_le_bytes(),
                player.as_ref(),
            ],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        msg!("Player state delegated to ER");
        Ok(())
    }

    // ── 10. End match — commit + undelegate back to L1 ─────────────────────
    // No status check — game server is trusted (authenticated via signer constraint).
    // On-chain game actions are fire-and-forget so status may lag behind relay state.
    pub fn end_match(ctx: Context<EndMatch>, _match_id: u64) -> Result<()> {
        let m = &mut ctx.accounts.arena_match;

        let match_id = m.match_id;
        let winner = m.winner;

        m.exit(&crate::ID)?;

        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&m.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        msg!("Match {} undelegated to L1. Winner: {}", match_id, winner);
        Ok(())
    }

    // ── 11. Create player state (on L1, before delegation) ─────────────────
    pub fn create_player_state(
        ctx: Context<CreatePlayerState>,
        match_id: u64,
    ) -> Result<()> {
        let ps = &mut ctx.accounts.player_state;
        ps.match_id = match_id;
        ps.player = ctx.accounts.player.key();
        ps.dx = 0;
        ps.dy = 0;
        ps.attacking = false;
        ps.last_tick = 0;
        ps.input_count = 0;
        msg!("Player state created for match {} player {}", match_id, ps.player);
        Ok(())
    }

    // ── 12. Cancel match (before any player joined or on error) ────────────
    pub fn cancel_match(ctx: Context<CancelMatch>, _match_id: u64) -> Result<()> {
        let m = &ctx.accounts.arena_match;
        require!(
            m.status == MatchStatus::WaitingForPlayer,
            ArenaError::MatchAlreadyStarted
        );
        msg!("Match {} cancelled", m.match_id);
        Ok(())
    }

    // ── 13. Close match PDA — reclaim rent after settlement ──────────────
    pub fn close_match(_ctx: Context<CloseMatch>, _match_id: u64) -> Result<()> {
        msg!("Match PDA closed, rent reclaimed");
        Ok(())
    }

    // ── 14. Close player state PDA — reclaim rent after settlement ───────
    pub fn close_player_state(_ctx: Context<ClosePlayerState>, _match_id: u64) -> Result<()> {
        msg!("Player state PDA closed, rent reclaimed");
        Ok(())
    }

    // ═════════════════════════════════════════════════════════════════════
    // DERBY INSTRUCTIONS
    // ═════════════════════════════════════════════════════════════════════

    // ── D1. Create derby race (on L1) ────────────────────────────────────
    pub fn create_derby(
        ctx: Context<CreateDerby>,
        race_id: u64,
        vrf_seed: [u8; 32],
    ) -> Result<()> {
        let d = &mut ctx.accounts.derby_race;
        d.race_id = race_id;
        d.game_server = ctx.accounts.game_server.key();
        d.player = ctx.accounts.player.key();
        d.vrf_seed = vrf_seed;
        d.status = DerbyStatus::Created;
        d.current_tick = 0;
        d.current_lap = 0;
        d.checkpoints_passed = 0;
        d.collisions = 0;
        d.gold_collected = 0;
        d.boosts_collected = 0;
        d.boost_end_tick = 0;
        d.finish_tick = 0;
        d.gold_bitmask = 0;
        d.boost_bitmask = 0;
        d.created_at = Clock::get()?.unix_timestamp;
        d.settled_at = 0;
        msg!("Derby {} created by {} (server: {})", race_id, d.player, d.game_server);
        Ok(())
    }

    // ── D2. Delegate derby to ER ─────────────────────────────────────────
    pub fn delegate_derby(ctx: Context<DelegateDerby>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[DERBY_SEED, &ctx.accounts.pda.race_id.to_le_bytes()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        msg!("Derby delegated to ER");
        Ok(())
    }

    // ── D3. Start derby (server only, on ER) ─────────────────────────────
    pub fn start_derby(ctx: Context<DerbyServerAction>, _race_id: u64) -> Result<()> {
        let d = &mut ctx.accounts.derby_race;
        require!(d.status == DerbyStatus::Created, DerbyError::InvalidDerbyState);
        d.status = DerbyStatus::Racing;
        d.current_tick = 0;
        d.current_lap = 0;
        d.checkpoints_passed = 0;
        msg!("Derby {} started", d.race_id);
        Ok(())
    }

    // ── D4. Submit derby input (player, on ER) ───────────────────────────
    #[session_auth_or(
        ctx.accounts.payer.key() == ctx.accounts.player.key(),
        SessionError::InvalidToken
    )]
    pub fn submit_derby_input(
        ctx: Context<DerbySubmitInput>,
        _race_id: u64,
        tick: u32,
        _dx: i8,
        _dy: i8,
    ) -> Result<()> {
        let d = &mut ctx.accounts.derby_race;
        require!(d.status == DerbyStatus::Racing, DerbyError::RaceNotActive);
        require!(tick <= DERBY_MAX_TICKS, DerbyError::RaceTimedOut);

        if tick > d.current_tick {
            d.current_tick = tick;
        }

        Ok(())
    }

    // ── D5. Derby server update (server validates collisions/pickups) ────
    pub fn derby_server_update(
        ctx: Context<DerbyServerAction>,
        _race_id: u64,
        action: DerbyAction,
    ) -> Result<()> {
        let d = &mut ctx.accounts.derby_race;
        require!(d.status == DerbyStatus::Racing, DerbyError::RaceNotActive);

        match action {
            DerbyAction::RecordCollision => {
                d.collisions = d.collisions.saturating_add(1);
                msg!("Derby {}: collision #{}", d.race_id, d.collisions);
            }
            DerbyAction::CollectGold { item_index } => {
                require!(item_index < DERBY_MAX_GOLD, DerbyError::InvalidItemIndex);
                let bit = 1u16 << item_index;
                require!(d.gold_bitmask & bit == 0, DerbyError::ItemAlreadyCollected);
                d.gold_bitmask |= bit;
                d.gold_collected = d.gold_collected.saturating_add(1);
                msg!("Derby {}: gold #{} collected", d.race_id, item_index);
            }
            DerbyAction::CollectBoost { item_index } => {
                require!(item_index < DERBY_MAX_BOOSTS, DerbyError::InvalidItemIndex);
                let bit = 1u8 << item_index;
                require!(d.boost_bitmask & bit == 0, DerbyError::ItemAlreadyCollected);
                d.boost_bitmask |= bit;
                d.boosts_collected = d.boosts_collected.saturating_add(1);
                d.boost_end_tick = d.current_tick.saturating_add(DERBY_BOOST_DURATION_TICKS);
                msg!("Derby {}: boost #{} collected, active until tick {}", d.race_id, item_index, d.boost_end_tick);
            }
            DerbyAction::PassCheckpoint { checkpoint_id } => {
                require!(checkpoint_id < DERBY_CHECKPOINT_COUNT, DerbyError::InvalidCheckpoint);
                let bit = 1u8 << checkpoint_id;
                d.checkpoints_passed |= bit;
                msg!("Derby {}: checkpoint {} passed", d.race_id, checkpoint_id);
            }
            DerbyAction::CompleteLap => {
                let all_checkpoints = (1u8 << DERBY_CHECKPOINT_COUNT) - 1;
                require!(d.checkpoints_passed & all_checkpoints == all_checkpoints, DerbyError::MissingCheckpoints);
                d.current_lap = d.current_lap.saturating_add(1);
                d.checkpoints_passed = 0; // reset for next lap
                msg!("Derby {}: lap {} complete", d.race_id, d.current_lap);
            }
            DerbyAction::FinishRace => {
                require!(d.current_lap >= DERBY_MAX_LAPS, DerbyError::LapsNotComplete);
                d.status = DerbyStatus::Finished;
                d.finish_tick = d.current_tick;
                d.settled_at = Clock::get()?.unix_timestamp;
                msg!("Derby {}: finished at tick {}", d.race_id, d.finish_tick);
            }
        }

        Ok(())
    }

    // ── D6. End derby — commit + undelegate back to L1 ───────────────────
    pub fn end_derby(ctx: Context<EndDerby>, _race_id: u64) -> Result<()> {
        let d = &mut ctx.accounts.derby_race;
        require!(
            d.status == DerbyStatus::Finished || d.status == DerbyStatus::Cancelled,
            DerbyError::RaceNotFinished
        );

        let race_id = d.race_id;
        let finish_tick = d.finish_tick;

        d.exit(&crate::ID)?;

        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&d.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        msg!("Derby {} undelegated to L1. Finish tick: {}", race_id, finish_tick);
        Ok(())
    }

    // ── D7. Close derby — reclaim rent after settlement ──────────────────
    pub fn close_derby(ctx: Context<CloseDerby>, _race_id: u64) -> Result<()> {
        let d = &ctx.accounts.derby_race;
        require!(
            d.status == DerbyStatus::Finished || d.status == DerbyStatus::Cancelled,
            DerbyError::RaceNotFinished
        );
        msg!("Derby {} closed, rent reclaimed", d.race_id);
        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCOUNT STRUCTS
// ═══════════════════════════════════════════════════════════════════════════

#[account]
pub struct ArenaMatchState {
    pub match_id: u64,            // 8
    pub game_server: Pubkey,      // 32 — authority for server-only actions
    pub player1: Pubkey,          // 32
    pub player2: Pubkey,          // 32
    pub status: MatchStatus,      // 1
    pub current_round: u8,        // 1
    pub player1_rounds_won: u8,   // 1
    pub player2_rounds_won: u8,   // 1
    pub player1_hp: u8,           // 1
    pub player2_hp: u8,           // 1
    pub current_tick: u32,        // 4
    pub round_start_tick: u32,    // 4
    pub last_p1_damage_tick: u32, // 4
    pub last_p2_damage_tick: u32, // 4
    pub winner: Pubkey,           // 32
    pub created_at: i64,          // 8
    pub settled_at: i64,          // 8
}

impl ArenaMatchState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1 + 1 + 1 + 1 + 1 + 1 + 4 + 4 + 4 + 4 + 32 + 8 + 8;
}

#[account]
pub struct PlayerState {
    pub match_id: u64,    // 8
    pub player: Pubkey,   // 32
    pub dx: i8,           // 1
    pub dy: i8,           // 1
    pub attacking: bool,  // 1
    pub last_tick: u32,   // 4
    pub input_count: u64, // 8
}

impl PlayerState {
    pub const LEN: usize = 8 + 32 + 1 + 1 + 1 + 4 + 8;
}

#[account]
pub struct DerbyRaceState {
    pub race_id: u64,           // 8
    pub game_server: Pubkey,    // 32
    pub player: Pubkey,         // 32
    pub vrf_seed: [u8; 32],     // 32
    pub status: DerbyStatus,    // 1
    pub current_tick: u32,      // 4
    pub current_lap: u8,        // 1
    pub checkpoints_passed: u8, // 1 — bitmask per lap (4 bits used)
    pub collisions: u16,        // 2
    pub gold_collected: u8,     // 1
    pub boosts_collected: u8,   // 1
    pub boost_end_tick: u32,    // 4
    pub finish_tick: u32,       // 4
    pub gold_bitmask: u16,      // 2 — which gold coins collected (15 bits)
    pub boost_bitmask: u8,      // 1 — which boosts collected (8 bits)
    pub created_at: i64,        // 8
    pub settled_at: i64,        // 8
}

impl DerbyRaceState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1 + 4 + 1 + 1 + 2 + 1 + 1 + 4 + 4 + 2 + 1 + 8 + 8;
}

// ═══════════════════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════════════════

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MatchStatus {
    WaitingForPlayer, // 0
    Countdown,        // 1
    Active,           // 2
    RoundEnd,         // 3
    Complete,         // 4
    Cancelled,        // 5
}

impl Default for MatchStatus {
    fn default() -> Self {
        MatchStatus::WaitingForPlayer
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DerbyStatus {
    Created,   // 0 — on L1, awaiting delegation
    Racing,    // 1 — active on ER
    Finished,  // 2 — race complete
    Cancelled, // 3
}

impl Default for DerbyStatus {
    fn default() -> Self {
        DerbyStatus::Created
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DerbyAction {
    RecordCollision,
    CollectGold { item_index: u8 },
    CollectBoost { item_index: u8 },
    PassCheckpoint { checkpoint_id: u8 },
    CompleteLap,
    FinishRace,
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCOUNT CONTEXTS
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateMatch<'info> {
    #[account(
        init,
        payer = player1,
        space = 8 + ArenaMatchState::LEN,
        seeds = [MATCH_SEED, &match_id.to_le_bytes()],
        bump
    )]
    pub arena_match: Account<'info, ArenaMatchState>,
    /// CHECK: Game server authority — stored in match state
    pub game_server: AccountInfo<'info>,
    #[account(mut)]
    pub player1: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts, Session)]
#[instruction(match_id: u64)]
pub struct JoinMatch<'info> {
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_id.to_le_bytes()],
        bump
    )]
    pub arena_match: Account<'info, ArenaMatchState>,
    /// CHECK: The player joining
    pub player2: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(signer = payer, authority = player2.key())]
    pub session_token: Option<Account<'info, SessionToken>>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct ServerAction<'info> {
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_id.to_le_bytes()],
        bump
    )]
    pub arena_match: Account<'info, ArenaMatchState>,
    #[account(
        mut,
        constraint = game_server.key() == arena_match.game_server @ ArenaError::UnauthorizedServer
    )]
    pub game_server: Signer<'info>,
}

#[derive(Accounts, Session)]
#[instruction(match_id: u64)]
pub struct SubmitInput<'info> {
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_id.to_le_bytes()],
        bump
    )]
    pub arena_match: Account<'info, ArenaMatchState>,
    #[account(
        mut,
        seeds = [PLAYER_STATE_SEED, &match_id.to_le_bytes(), player.key().as_ref()],
        bump
    )]
    pub player_state: Account<'info, PlayerState>,
    /// CHECK: The player submitting input
    pub player: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(signer = payer, authority = player.key())]
    pub session_token: Option<Account<'info, SessionToken>>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreatePlayerState<'info> {
    #[account(
        init,
        payer = player,
        space = 8 + PlayerState::LEN,
        seeds = [PLAYER_STATE_SEED, &match_id.to_le_bytes(), player.key().as_ref()],
        bump
    )]
    pub player_state: Account<'info, PlayerState>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateMatch<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The match PDA to delegate — unchecked per MagicBlock pattern
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePlayerState<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player state PDA to delegate — unchecked per MagicBlock pattern
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
}

#[commit]
#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct EndMatch<'info> {
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_id.to_le_bytes()],
        bump
    )]
    pub arena_match: Account<'info, ArenaMatchState>,
    #[account(
        mut,
        constraint = payer.key() == arena_match.game_server @ ArenaError::UnauthorizedServer
    )]
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CancelMatch<'info> {
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_id.to_le_bytes()],
        bump,
        close = player1,
        constraint = arena_match.player1 == player1.key() @ ArenaError::UnauthorizedPlayer,
    )]
    pub arena_match: Account<'info, ArenaMatchState>,
    #[account(mut)]
    pub player1: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CloseMatch<'info> {
    #[account(
        mut,
        seeds = [MATCH_SEED, &match_id.to_le_bytes()],
        bump,
        close = payer,
        // No status check — game server is trusted to close at any time.
        // On-chain status may lag behind relay state due to fire-and-forget ER actions.
        constraint = payer.key() == arena_match.game_server @ ArenaError::UnauthorizedServer,
    )]
    pub arena_match: Account<'info, ArenaMatchState>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct ClosePlayerState<'info> {
    #[account(
        seeds = [MATCH_SEED, &match_id.to_le_bytes()],
        bump,
        constraint = payer.key() == arena_match.game_server @ ArenaError::UnauthorizedServer,
    )]
    pub arena_match: Account<'info, ArenaMatchState>,
    #[account(
        mut,
        seeds = [PLAYER_STATE_SEED, &match_id.to_le_bytes(), player_state.player.as_ref()],
        bump,
        close = payer,
    )]
    pub player_state: Account<'info, PlayerState>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

// ── Derby Contexts ────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct CreateDerby<'info> {
    #[account(
        init,
        payer = player,
        space = 8 + DerbyRaceState::LEN,
        seeds = [DERBY_SEED, &race_id.to_le_bytes()],
        bump
    )]
    pub derby_race: Account<'info, DerbyRaceState>,
    /// CHECK: Game server authority — stored in race state
    pub game_server: AccountInfo<'info>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateDerby<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The derby PDA to delegate
    #[account(mut, del)]
    pub pda: Account<'info, DerbyRaceState>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct DerbyServerAction<'info> {
    #[account(
        mut,
        seeds = [DERBY_SEED, &race_id.to_le_bytes()],
        bump
    )]
    pub derby_race: Account<'info, DerbyRaceState>,
    #[account(
        mut,
        constraint = game_server.key() == derby_race.game_server @ DerbyError::UnauthorizedServer
    )]
    pub game_server: Signer<'info>,
}

#[derive(Accounts, Session)]
#[instruction(race_id: u64)]
pub struct DerbySubmitInput<'info> {
    #[account(
        mut,
        seeds = [DERBY_SEED, &race_id.to_le_bytes()],
        bump
    )]
    pub derby_race: Account<'info, DerbyRaceState>,
    /// CHECK: The player submitting input
    pub player: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(signer = payer, authority = player.key())]
    pub session_token: Option<Account<'info, SessionToken>>,
}

#[commit]
#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct EndDerby<'info> {
    #[account(
        mut,
        seeds = [DERBY_SEED, &race_id.to_le_bytes()],
        bump
    )]
    pub derby_race: Account<'info, DerbyRaceState>,
    #[account(
        mut,
        constraint = payer.key() == derby_race.game_server @ DerbyError::UnauthorizedServer
    )]
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct CloseDerby<'info> {
    #[account(
        mut,
        seeds = [DERBY_SEED, &race_id.to_le_bytes()],
        bump,
        close = payer,
        constraint = derby_race.game_server == payer.key() @ DerbyError::UnauthorizedServer
    )]
    pub derby_race: Account<'info, DerbyRaceState>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

// ═══════════════════════════════════════════════════════════════════════════
// ERRORS
// ═══════════════════════════════════════════════════════════════════════════

#[error_code]
pub enum ArenaError {
    #[msg("Match is not in a joinable state")]
    MatchNotJoinable,
    #[msg("Cannot join your own match")]
    CannotJoinOwnMatch,
    #[msg("Match is not active")]
    MatchNotActive,
    #[msg("Match is not complete")]
    MatchNotComplete,
    #[msg("Match has already started")]
    MatchAlreadyStarted,
    #[msg("Invalid match state for this action")]
    InvalidMatchState,
    #[msg("Invalid target slot (must be 1 or 2)")]
    InvalidTargetSlot,
    #[msg("Damage cooldown not elapsed")]
    DamageCooldown,
    #[msg("Unauthorized game server")]
    UnauthorizedServer,
    #[msg("Unauthorized player")]
    UnauthorizedPlayer,
}

#[error_code]
pub enum DerbyError {
    #[msg("Invalid derby state for this action")]
    InvalidDerbyState,
    #[msg("Race is not active")]
    RaceNotActive,
    #[msg("Race is not finished or cancelled")]
    RaceNotFinished,
    #[msg("Race timed out")]
    RaceTimedOut,
    #[msg("Invalid item index")]
    InvalidItemIndex,
    #[msg("Item already collected")]
    ItemAlreadyCollected,
    #[msg("Invalid checkpoint ID")]
    InvalidCheckpoint,
    #[msg("Not all checkpoints passed")]
    MissingCheckpoints,
    #[msg("Not all laps complete")]
    LapsNotComplete,
    #[msg("Unauthorized game server")]
    UnauthorizedServer,
}
