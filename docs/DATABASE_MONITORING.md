# Database Monitoring

This document describes how Lyricsflip's database and settlement pipeline are
monitored, and which Prometheus metrics and alert rules operators should wire
up.

## Metrics

The Prometheus registry exposes the following settlement-related metrics:

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `lyricsflip_wagers_by_status` | gauge | `status` | Number of wagers currently in each status. |
| `lyricsflip_settlement_failures_total` | counter | `kind` | Settlement failures that need operator attention, broken down by failure kind. |
| `lyricsflip_reconcile_giveups_total` | counter | — | Number of times the wager reconciliation job gave up and moved a wager to `FAILED`. |
| `lyricsflip_refund_failures_total` | counter | — | Number of refunds that failed during `createWager`. |
| `lyricsflip_oldest_settling_wager_age_seconds` | gauge | — | Age in seconds of the oldest wager still in `SETTLING`. |

Each operator-attention case (reconciliation give-up, refund failure) increments
the corresponding counter, so these conditions can be alerted on instead of
relying on `ALERT:` log lines.

## Alert rules

Example Prometheus alert rules live in [`docs/alerts.yml`](./alerts.yml). Load
them into Prometheus alongside your scrape configuration, for example:

```yaml
rule_files:
  - /etc/prometheus/alerts.yml
```

The rules cover:

- **Any reconciliation give-up** — fires as soon as
  `lyricsflip_reconcile_giveups_total` increases.
- **Stuck settlement** — fires when a wager has been in `SETTLING` for more than
  15 minutes (`lyricsflip_oldest_settling_wager_age_seconds > 900`).
- **Elevated settlement failure rate** — fires when the settlement failure rate
  exceeds the configured threshold.

## Dashboards

Grafana dashboards should graph `lyricsflip_wagers_by_status` alongside the
counters above to correlate settlement failures with the wager backlog.
