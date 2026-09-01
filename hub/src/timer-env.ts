// A millisecond delay read from the environment, bounded to what a timer can actually honour.
//
// Its own module because three files need the same guard and none of them should import the others:
// daemon-notifiers.ts (seven tick knobs + the WAL checkpoint), linear.ts (the mirror fetch abort) and
// channel.ts (the notify fetch abort).
//
// `Number(env) || dflt` — the shape all of them used — accepts two values it must not. A NEGATIVE number
// is truthy, and anything past Node's 32-bit timer limit passes the expression untouched; setTimeout and
// setInterval coerce BOTH to 1ms. So the failure is never a slow cadence: it is a DB read or a webhook
// send every millisecond, or an abort controller that fires ~1ms into every request, failing every mirror
// push and every Slack notify. 24e219c bounded the seven tick knobs and claimed "one bounded reader now
// covers all seven"; the two abort timers were not among them, and the reader had no test at all, so
// reverting it would have left the suite green.
export const MAX_TIMER_MS = 2_147_483_647;

/** `process.env[name]` as a delay, or `dflt` when it is absent, unparseable, non-positive, or past the limit. */
export function timerEnvMs(name: string, dflt: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0 || raw > MAX_TIMER_MS) return dflt;
  return raw;
}
