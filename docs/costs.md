# Cost estimates: sources, derivation, and coverage

Mari v0.1 shows **internal estimates**, not invoices. No payment system or
provider billing export is connected, and the cost meter never authorizes or
blocks work. Quotas are a separate policy described in
[`limits-hooks.md`](limits-hooks.md).

Rates below were checked on **2026-07-27**. Provider prices and included
allowances can change; review the linked source before changing the constants.

## Source rates

| Item | Source rate | Mari constant / derivation |
|---|---:|---|
| Cloudflare Containers memory | $0.0000025/GiB-s = $0.009/GiB-h | `standard-1`: 4 GiB × $0.009 = $0.036/h |
| Cloudflare Containers CPU | $0.000020/vCPU-s = $0.072/vCPU-h | 0.5 vCPU × **20% assumed duty** × $0.072 = $0.0072/h |
| Cloudflare Containers disk | $0.00000007/GB-s = $0.000252/GB-h | 8 GB × $0.000252 = $0.002016/h |
| **Cloudflare `standard-1` active estimate** | — | $0.036 + $0.0072 + $0.002016 = **$0.045216/h**, rounded to **$0.0452/h** |
| Cloudflare `standard-1` idle estimate | — | memory + disk, zero assumed CPU = **$0.038016/h**, rounded to **$0.038/h** |
| Box active VM time | $1 / 100,000 running seconds | **$0.036/h** |
| R2 Standard storage | $0.015/GB-month | **$0.015/GB-month**; recorded as a constant, not yet applied to an estimate |
| R2 Standard operations | Class A $4.50/million; Class B $0.36/million | not metered |

Sources: [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/),
[Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/), and
[Box billing](https://docs.ascii.dev/box/billing). The deployed instance size is
pinned in `packages/control-plane/wrangler.jsonc` as Cloudflare `standard-1`
(0.5 vCPU, 4 GiB memory, 8 GB disk).

Cloudflare's pricing page also lists Workers Paid included usage (25 GiB-hours
memory, 375 vCPU-minutes and 200 GB-hours disk per month) and region-specific
network charges. R2 lists a monthly free tier and rounds billable units. Mari's
meter deliberately uses gross list rates: it does not allocate account-wide free
tiers, discounts, rounding, or egress to an individual computer.

## The two v0.1 meters

### Fleet-card lifetime AWAKE estimate

`packages/control-plane/src/pricing.ts` prices the Durable Object's lifetime
`awakeSeconds` with `SUBSTRATE_PRICE_PER_HOUR`. The counter includes the open
AWAKE stretch and survives later WARM/COLD presentation. The window is **since
creation**; live burn rate is zero outside AWAKE.

Hosted Cloudflare and Box use the sourced rates above. Docker is $0 because it
runs on the user's own machine. The `sprites`, `sail`, `northflank`, `fake`, and
unknown-substrate entries are static planning placeholders, not provider-bill
reconciliations; do not present them as quoted vendor prices.

### Per-computer monthly usage estimate

`GET /api/computers/:id/usage[?period=YYYY-MM]` reads `usage_ledger` from
`packages/control-plane/src/usage.ts`. It returns:

- `awakeMs`, split across UTC calendar months when a stretch crosses a boundary;
- `boxMs`, the started-to-completed duration of each completed run;
- `runCount`; and
- `estimatedUsd = awake hours × $0.0452 + box hours × $0.036`.

The v0.1 run-completion hook does not persist a substrate dimension: it records
`boxMs` for every completed run. Therefore the sum is a conservative model, not
a claim that Box billed those seconds; a run on Cloudflare can contribute to
both terms. Substrate-aware attribution or provider invoice reconciliation must
precede billing use.

## Included and excluded

Included today:

- control-plane-observed AWAKE intervals;
- completed-run elapsed time and run count;
- UTC-month splitting; and
- a static list-price estimate at nanodollar precision.

Not included today:

- actual Cloudflare CPU duty (20% is an assumption), memory/disk size changes,
  stopped-instance retention, or per-region egress;
- Workers request/CPU charges, Durable Object requests/duration/storage/alarms,
  D1 operations/storage, container image builds/storage, or persisted log cost;
- R2 bytes at rest, Class A/B operations, multipart minimums, free tiers,
  rounding, or account-wide discounts;
- Box snapshots, network overages, plan credits, failed/abandoned runs, or
  provider-side rounding;
- taxes, currency conversion, refunds, negotiated pricing, and every external
  provider invoice.

`R2_DELTA_USD_PER_GB_MONTH` and the Cloudflare idle constant document future
inputs; neither is applied by `estimatedUsd`. Treat the UI value as an operations
signal with visible assumptions, never as a charge to a customer.
