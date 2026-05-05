---
status: planned
theme: crash-protection-and-simulation
---

# Roll Protective Puts Before Final Month

As a long-term bullish Bitcoin user, I want protective puts to roll before their
final month so that theta decay does not consume the hedge at the worst time.

## Acceptance Criteria

- [ ] The user can define a put ladder with target moneyness and expiry tenors.
- [ ] The app identifies put positions with less than one month to expiry.
- [ ] The app stages selling near-expiry puts and buying replacement puts.
- [ ] Staging validates hedge continuity: any roll must keep post-roll hedge
      coverage at or above a configured minimum threshold (e.g. minimum
      coverage ratio of notional protected to underlying exposure). If the
      candidate roll would drop below the threshold, the staging step
      surfaces the gap rather than silently producing a roll task.
- [ ] The user can review roll trades before execution; the review step
      shows the projected post-roll coverage and blocks or visibly warns
      when the configured threshold would be violated.
- [ ] The app does not execute roll trades automatically without explicit
      approval.
