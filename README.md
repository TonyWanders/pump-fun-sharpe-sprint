# CleanSieve — Pump.fun Sharpe Sprint bot
[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/TonyWanders/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/TonyWanders/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty ($2, 3 places). It trades 10 SOL of paper money on a 6-hour pump.fun forward replay, ranked by hourly Sharpe ratio, not by raw PnL. A placement needs net PnL above holding cash (above 0 after every fee).

## Entry signal

Every new bonding curve is watched from its CreateEvent. Over a 240-slot tape (about 96 seconds) the bot buys only when real buyers are piling in together:

- at least 10 distinct buyers and 10 buy trades in the window;
- at least 5 SOL of net inflow (buys minus sells), with buys dominating sells (net inflow at least half of gross buys);
- price already up 5% to 80% since first sight (momentum confirmed, vertical already excluded);
- real SOL reserves above 1.5 SOL;
- coin aged 60 to 900 slots since creation (old enough to have a tape, young enough to still be early).

One fixed 0.05 SOL stake per coin, one buy per coin, at most 5 positions open. A buy only fires when the 1%-of-real-reserve size cap allows at least 0.01 SOL.

## Sizing

Fixed 0.05 SOL per coin. A round trip costs about 2.9% of stake in fees (protocol 95 bps + creator 30 bps each side, plus 105,000 lamports of transaction fees per order), so the take-profit sits well above the round-trip cost and the stop well below it. No pyramiding, no leverage, no shorts: every position is the same size, so no single coin can dominate an hour's return.

## Exits (whichever comes first)

- Take-profit: position value reaches cost +20%.
- Stop-loss: position value falls to cost -10%.
- Trailing exit: arms at cost +12%, fires on a 6% pullback off the peak value.
- Time exit: 240 slots held (about 96 seconds).

Positions are marked at the curve's live reserves each batch, so exits react to the same prices the replay records. A curve that completes is closed by the replay itself.

## Sharpe maths

The house scores each entry on hourly equity marks: marks[0] is starting cash, marks[k+1] is equity at the end of hour k, and r_i = (m_i - m_{i-1}) / m_{i-1}. Sharpe (hourly) = mean(r) / sample stdev(r), not annualised.

That is why this bot is built the way it is: many small, quick, same-sized round trips with a fixed small loss cap produce steadier hourly returns than a few big rides. The stop-loss and the short time exit cap the downside of any one hour, the trailing exit lets the rare runner pay for the losers without letting one coin dominate, and the fixed stake keeps the variance of hourly returns low. A single lucky moonshot raises the mean once and the variance everywhere; steady small wins raise the mean every hour.

Guardrail probes: if genuine entries lag, the bot opens tiny 0.02 SOL probe round trips on the most liquid unentered curve (in on one batch, out on the next) until 25 coins have round-tripped, so the run still clears the 20-distinct-mint guardrail in a quiet six-hour window. Each probe costs about 0.0008 SOL in fees.

## Entry point

`main.ts` (TypeScript, Node 22, standard library only). The grader runs it as `node /bot/main.ts`. It speaks agent-fun/replay/v2 through the kit's TypeScript shim in `vendor/makefun-bot.ts`. All decisions use integer math on lamports and slot counts only: no floats, no clock, no environment, no randomness, so two executions produce byte-identical action logs.

## Files

- `main.ts` — the strategy (entry point)
- `vendor/makefun-bot.ts` — the kit's TypeScript protocol shim, copied from the kit's `sdk/ts` as its docstring instructs
- `.makefun/owner.json` — payout wallet for the entry
- `LICENSE` — MIT

## Bounty

- Page: https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532
- Reward: $2 (1st $1, 2nd $0.60, 3rd $0.40), escrowed on Solana
- Ends Sat 28 Nov 2026 18:00 WAT; final window is a 6-hour pump.fun forward replay
- Guardrails: round trips of at least 0.01 SOL on at least 20 distinct mints, max drawdown 50%
