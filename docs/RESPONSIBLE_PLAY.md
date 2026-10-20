# Responsible Play Policy

This document describes the stake limits and responsible-play controls enforced by the wager service. These controls exist to protect users and to satisfy jurisdictional requirements for products that move real tokens.

## Global stake limits

The following settings are configured at the application level (environment / config):

| Setting | Description |
| --- | --- |
| `WAGER_MIN_STAKE` | Minimum allowed `wagerAmount` for a new wager. Stakes below this are rejected with `400 Bad Request`. |
| `WAGER_MAX_STAKE` | Maximum allowed `wagerAmount` for a new wager. Stakes above this are rejected with `400 Bad Request`. |
| `WAGER_MAX_OPEN_PER_USER` | Maximum number of concurrently open wagers a single user may hold. Creating a wager beyond this cap is rejected with `403 Forbidden`. |

Stakes must also remain within the token's `i128` range; the configured min/max are enforced in addition to that hard bound.

## Per-user controls

Each user has two responsible-play settings stored on their profile:

- **Daily stake limit** — the maximum total stake a user may commit within a rolling day.
- **Self-exclusion end date** — a timestamp until which the user is barred from gambling activity.

### Cooling-off period

- **Lowering** a daily stake limit takes effect **immediately**.
- **Raising** (or removing) a daily stake limit takes effect only **after a cooling-off period**, so a user cannot undo a protective limit in the heat of the moment. The pending value and its effective time are tracked separately from the active limit.

### Self-exclusion

A self-excluded user cannot **create** or **accept** wagers until the exclusion end date has passed. Attempts are rejected with `403 Forbidden` and a message indicating when the exclusion ends.

## Exposing limits

A user's active limits, pending limit changes, and self-exclusion end date are exposed on `GET /users/me` so clients can display them and prevent disallowed actions in the UI.

## Error responses

- `400 Bad Request` — stake outside the configured `WAGER_MIN_STAKE`/`WAGER_MAX_STAKE` range, or a daily stake limit would be exceeded.
- `403 Forbidden` — user is self-excluded, or has reached `WAGER_MAX_OPEN_PER_USER` open wagers.
