# Roll Protective Puts Before Final Month

As a long-term bullish Bitcoin user, I want protective puts to roll before their
final month so that theta decay does not consume the hedge at the worst time.

## Status

Planned.

## Acceptance Criteria

- [ ] The user can define a put ladder with target moneyness and expiry tenors.
- [ ] The app identifies put positions with less than one month to expiry.
- [ ] The app stages selling near-expiry puts and buying replacement puts.
- [ ] The user can review roll trades before execution.
- [ ] The app does not execute roll trades automatically without explicit
      approval.
