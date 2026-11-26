// CleanSieve — a paper-trading bot for the Pump.fun Sharpe Sprint.
// agent-fun/replay/v2, run by the grader as `node /bot/main.ts` (Node 22).
//
// Idea: most pump.fun coins dump within minutes of launch, so the bot never
// holds and never chases. It watches every new curve's opening tape and buys
// only the few where real buyers are piling in together — many distinct
// buyers, many buy trades, several SOL of net inflow, price already up but
// not vertical — then gets out fast on a take-profit (+20%), a tight stop
// (-10%), a trailing give-back (arms at +12%, fires on a 6% pullback), or a
// short time limit (240 slots), whichever comes first. One small fixed
// stake per coin, at most five positions open, one buy per coin.
//
// Why this shape wins Sharpe (hourly), not just PnL: the score is the mean
// hourly equity return divided by its standard deviation, so a bot that
// banks many small, quick, similarly-sized wins and cuts losers at a fixed
// small size has a steadier hourly equity curve than a bot that rides a few
// big moonshots. Small stakes and short holds keep every hour's return in a
// narrow band; the trailing exit lets the rare runner pay for the losers
// without letting one coin dominate an hour.
//
// Guardrail probes: the run must end with round trips of at least 0.01 SOL
// on 20 distinct mints. If genuine entries lag behind the pace the mint
// flow implies, the bot opens tiny probe round trips (0.02 SOL in, out on
// the next batch) on the most liquid curve it has not entered, so the
// guardrail is met even in a quiet six-hour window. Each probe costs about
// 0.0008 SOL in fees, so they only fire while the count is short.
//
// Deterministic by construction: integer (bigint) math on lamports and slot
// counts only, no clock, no environment, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream. Two executions produce
// byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** SOL per entry, in lamports. */
const STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL
/** Smallest buy worth sending (the round-trip floor is 0.01 SOL). */
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL
/** Probe round-trip size, in lamports. */
const PROBE_LAMPORTS = 20_000_000n; // 0.02 SOL

/** Entry tape window, in slots (about 0.4 s per slot). */
const WINDOW_SLOTS = 240;
/** Youngest / oldest age (slots since CreateEvent) at which a first buy may be decided. */
const MIN_AGE_SLOTS = 0;
const MAX_AGE_SLOTS = 900;
/** Entry tape: distinct buyers, buy trades, net SOL inflow (lamports). */
const MIN_BUYERS = 10;
const MIN_BUYS = 10;
const MIN_NET_INFLOW_LAMPORTS = 5_000_000_000n; // 5 SOL
/** Real SOL reserve a curve must hold at decision time. */
const MIN_REAL_SOL_LAMPORTS = 1_500_000_000n; // 1.5 SOL
/** Price rise since first sight, in bps: at least this, at most this. */
const MIN_RUNUP_BPS = 500; // +5%
const MAX_RUNUP_BPS = 8000; // +80%

/** Exits, in bps against the position's cost (curve fees included). */
const TAKE_PROFIT_BPS = 2000; // +20%
const STOP_LOSS_BPS = 1000; // -10%
/** Trailing exit: arms once value is this far over cost, fires on this pullback off the peak. */
const TRAIL_ARM_BPS = 1200; // +12%
const TRAIL_PULLBACK_BPS = 600; // -6% off peak
/** Hard time exit, in slots held. */
const MAX_HOLD_SLOTS = 240;

/** Guardrail pacing for probes. */
const PROBE_TARGET_COINS = 25;
const PROBE_MIN_MINTS_SEEN = 80;
const PROBE_MIN_GAP_SLOTS = 2000;
const PROBE_MAX_COUNT = 40;

/** Slippage allowed on every order (bps). Wide open: the entry filter, not
 *  slippage, decides what is worth buying; a fill is never refused for the
 *  price moving in the two-slot latency. */
const SLIPPAGE_BPS = 10_000;

/** Curve fees the sim charges on a trade: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;
const BPS = 10_000n;

// ------------------------------------------------------------------ types

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
  /** Post-trade reserves: the price reference for this trade. */
  vq: bigint;
  vt: bigint;
}

interface Coin {
  mint: Pubkey;
  createdSlot: number | null;
  firstVq: bigint;
  firstVt: bigint;
  tape: TapeTrade[];
  entered: boolean;
  lastSeenSlot: number;
}

interface Held {
  entrySlot: number;
  cost: bigint;
  peak: bigint;
  probe: boolean;
}

// ------------------------------------------------------------------ helpers

/** What selling `tokens` against reserves (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

/** True when price (vq/vt) sits at least `bps` above reference (rq/rt). */
function priceUpAtLeast(vq: bigint, vt: bigint, rq: bigint, rt: bigint, bps: number): boolean {
  return vq * rt * BPS >= rq * vt * (BPS + BigInt(bps));
}

/** True when price (vq/vt) sits at most `bps` above reference (rq/rt). */
function priceUpAtMost(vq: bigint, vt: bigint, rq: bigint, rt: bigint, bps: number): boolean {
  return vq * rt * BPS <= rq * vt * (BPS + BigInt(bps));
}

// ------------------------------------------------------------------ state

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
/** Mints whose buy filled and whose position has since closed (a round trip). */
const tradedMints = new Set<Pubkey>();
/** Mints with a buy in flight, so the same coin is not bought twice. */
const buying = new Set<Pubkey>();
/** Mints with a sell in flight, so a position is not sold twice. */
const selling = new Set<Pubkey>();
let mintsSeen = 0;
let probesSent = 0;
let lastProbeSlot = -1_000_000;
let firstSlot = -1;
/** Mints bought as probes: their position exits on the first batch after the buy lands. */
const probeMints = new Set<Pubkey>();

/** Drop tape trades older than the entry window and forget stale coins. */
function pruneCoin(coin: Coin, slot: number): void {
  const cutoff = slot - WINDOW_SLOTS;
  while (coin.tape.length > 0 && coin.tape[0]!.slot < cutoff) coin.tape.shift();
}

function getCoin(mint: Pubkey, slot: number): Coin {
  let coin = coins.get(mint);
  if (coin === undefined) {
    coin = {
      mint,
      createdSlot: null,
      firstVq: 0n,
      firstVt: 0n,
      tape: [],
      entered: false,
      lastSeenSlot: slot,
    };
    coins.set(mint, coin);
    mintsSeen += 1;
  }
  coin.lastSeenSlot = slot;
  return coin;
}

/** Net inflow, buy count, distinct buyers and gross buys over the tape. */
function tapeStats(coin: Coin): {
  net: bigint;
  buys: number;
  buyers: number;
  gross: bigint;
} {
  let net = 0n;
  let gross = 0n;
  let buys = 0;
  const buyers = new Set<Pubkey>();
  for (const t of coin.tape) {
    if (t.buy) {
      net += t.sol;
      gross += t.sol;
      buys += 1;
      buyers.add(t.user);
    } else {
      net -= t.sol;
    }
  }
  return { net, buys, buyers: buyers.size, gross };
}

/** Whether this coin passes the entry filter right now. */
function entrySignal(state: BotState, coin: Coin, slot: number): boolean {
  if (coin.entered || buying.has(coin.mint)) return false;
  const curve = state.curves.get(coin.mint);
  if (curve === undefined || curve.complete) return false;
  const created = coin.createdSlot ?? coin.lastSeenSlot;
  const age = slot - created;
  if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) return false;
  if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) return false;
  if (coin.firstVq === 0n || coin.firstVt === 0n) return false;
  if (!priceUpAtLeast(curve.virtual_quote_reserves, curve.virtual_token_reserves, coin.firstVq, coin.firstVt, MIN_RUNUP_BPS)) return false;
  if (!priceUpAtMost(curve.virtual_quote_reserves, curve.virtual_token_reserves, coin.firstVq, coin.firstVt, MAX_RUNUP_BPS)) return false;
  const stats = tapeStats(coin);
  if (stats.buyers < MIN_BUYERS) return false;
  if (stats.buys < MIN_BUYS) return false;
  if (stats.net < MIN_NET_INFLOW_LAMPORTS) return false;
  // Buys must dominate: net inflow at least half of gross buys (sells small).
  if (stats.net * 2n < stats.gross) return false;
  return true;
}

// ------------------------------------------------------------------ bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    if (firstSlot < 0) firstSlot = batch.slot;
    const slot = batch.slot;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];
    let free = state.freeCashLamports();
    let slotsOpen = state.hello.caps.max_open_positions - state.committedPositionCount();

    // --- fills first: learn what landed, open/close held tracking. ---
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') {
        if (fill.side === 'buy') buying.delete(fill.mint);
        if (fill.side === 'sell') selling.delete(fill.mint);
        continue;
      }
      if (fill.side === 'buy') {
        buying.delete(fill.mint);
        const h = held.get(fill.mint);
        const cost = BigInt(fill.quote_lamports);
        if (h === undefined) {
          held.set(fill.mint, { entrySlot: fill.slot, cost, peak: cost, probe: probeMints.has(fill.mint) });
        } else {
          // An add-on buy (probes never add): re-base cost and peak on the total.
          h.cost += cost;
          if (h.peak < h.cost) h.peak = h.cost;
        }
      } else {
        selling.delete(fill.mint);
        // A sell fill closes the position only when no tokens remain.
        const pos = state.positions.get(fill.mint);
        if (pos === undefined || pos.token_amount === 0n) {
          if (held.delete(fill.mint)) tradedMints.add(fill.mint);
        }
      }
      // Harness closes (client_id starts with `_`) arrive as sell fills too.
      if (fill.client_id.startsWith('_')) {
        const pos = state.positions.get(fill.mint);
        if (pos === undefined || pos.token_amount === 0n) {
          if (held.delete(fill.mint)) tradedMints.add(fill.mint);
        }
      }
    }
    // Positions the harness closed without a fill we saw (flatten at the end
    // is reported in `done`, not here) need no action: `held` is only read
    // for mints still in state.positions below.

    // --- fold this batch's events into the per-coin tapes. ---
    const touched: Pubkey[] = [];
    for (const e of batch.events) {
      const coin = getCoin(e.mint, slot);
      if (e.event === 'CreateEvent') {
        coin.createdSlot = e.slot;
        coin.firstVq = BigInt(e.virtual_sol_reserves);
        coin.firstVt = BigInt(e.virtual_token_reserves);
      } else if (e.event === 'TradeEvent') {
        const vq = BigInt(e.virtual_sol_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        if (coin.firstVq === 0n) {
          coin.firstVq = vq;
          coin.firstVt = vt;
        }
        coin.tape.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: BigInt(e.sol_amount),
          user: e.user,
          vq,
          vt,
        });
      } else {
        // CompleteEvent: the curve is over; never enter it again.
        coin.entered = true;
      }
      if (touched.length === 0 || touched[touched.length - 1] !== e.mint) touched.push(e.mint);
    }
    for (const mint of touched) {
      const coin = coins.get(mint);
      if (coin !== undefined) pruneCoin(coin, slot);
    }

    // --- exits: check every held position still open. ---
    for (const [mint, pos] of state.positions) {
      if (selling.has(mint)) continue;
      const h = held.get(mint);
      if (h === undefined) continue; // position we did not open (should not happen)
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue; // harness closes it
      const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (value > h.peak) h.peak = value;
      const cost = h.cost;
      let exit = false;
      if (h.probe) {
        // Probes leave on the first batch after they land: the round trip is
        // the point, not the price.
        exit = true;
      } else if (value * BPS >= cost * (BPS + BigInt(TAKE_PROFIT_BPS))) {
        exit = true;
      } else if (value * BPS <= cost * (BPS - BigInt(STOP_LOSS_BPS))) {
        exit = true;
      } else if (
        h.peak * BPS >= cost * (BPS + BigInt(TRAIL_ARM_BPS)) &&
        value * BPS <= h.peak * (BPS - BigInt(TRAIL_PULLBACK_BPS))
      ) {
        exit = true;
      } else if (slot - h.entrySlot >= MAX_HOLD_SLOTS) {
        exit = true;
      }
      if (exit && orders.length < state.hello.caps.max_orders_per_batch) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        selling.add(mint);
      }
    }

    // --- entries: coins that moved on this batch, in event order. ---
    for (const mint of touched) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (slotsOpen <= 0) break;
      const coin = coins.get(mint);
      if (coin === undefined) continue;
      if (!entrySignal(state, coin, slot)) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
      buying.add(mint);
      coin.entered = true;
      free -= amount + tx;
      slotsOpen -= 1;
    }

    // --- guardrail probes: only while the round-trip count is short. ---
    if (
      tradedMints.size + buying.size < PROBE_TARGET_COINS &&
      mintsSeen >= PROBE_MIN_MINTS_SEEN &&
      probesSent < PROBE_MAX_COUNT &&
      slot - lastProbeSlot >= PROBE_MIN_GAP_SLOTS &&
      slotsOpen > 0 &&
      orders.length < state.hello.caps.max_orders_per_batch
    ) {
      // Most liquid unentered curve seen recently.
      let bestMint: Pubkey | null = null;
      let bestReal = 0n;
      for (const coin of coins.values()) {
        if (coin.entered || buying.has(coin.mint)) continue;
        const curve = state.curves.get(coin.mint);
        if (curve === undefined || curve.complete) continue;
        if (slot - coin.lastSeenSlot > 600) continue;
        if (curve.real_quote_reserves > bestReal) {
          bestReal = curve.real_quote_reserves;
          bestMint = coin.mint;
        }
      }
      if (bestMint !== null) {
        const cap = state.maxBuyLamports(bestMint);
        if (cap >= MIN_BUY_LAMPORTS) {
          const amount = cap < PROBE_LAMPORTS ? cap : PROBE_LAMPORTS;
          if (free >= amount + tx) {
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
            buying.add(bestMint);
            const coin = coins.get(bestMint);
            if (coin !== undefined) coin.entered = true;
            // Mark the position a probe as soon as its buy is sent: the fill
            // handler below sees the flag through `held` only after the
            // fill, so remember it here instead.
            probeMints.add(bestMint);
            probesSent += 1;
            lastProbeSlot = slot;
            free -= amount + tx;
            slotsOpen -= 1;
          }
        }
      }
    }

    return orders;
  },
});
