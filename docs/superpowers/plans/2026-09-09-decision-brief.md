# Decision brief: what one year of Ethereum costs, and what we need decided

Date: 2026-09-09
Status: awaiting decisions from the research group and the institution
Background: [architecture](../specs/2026-09-08-scale-to-one-year-architecture.md) ·
[data model](../specs/2026-09-08-data-model.md) ·
[ingest](../specs/2026-09-08-ingest-pipeline.md) ·
[roadmap](2026-09-08-scale-roadmap.md)

Every number below is **measured**, not estimated: from the 100-block export in the repo,
real Parquet produced by `pipeline/repack.py`, a real ClickHouse load, and dry-run scan
estimates against the live BigQuery dataset on 2026-09-09. Nothing here has been paid for.

---

## 1. Size

| | One year | Five years |
|---|---|---|
| Rows (transactions + transfers) | ~2.2 B | ~8.5–11 B |
| **Published Parquet archive** | **270 GB** | ~1.0–1.4 TB |
| **ClickHouse working disk** | **409 GB** | ~1.6–2.1 TB |
| **Provision this much NVMe** (merge headroom) | **1 TB** | **3 TB** |

For scale: the same year stored in the current flat CSV shape would be **~58 TB**.
Normalizing is a ~200× reduction, and it is already implemented and verified.

**Where the bytes go, per year:**

| Column | GB | Share | Droppable? |
|---|---|---|---|
| `input` (contract calldata) | 75.6 | 28% | Partly — see Q2 |
| `r` + `s` (ECDSA signatures) | 76.0 | 28% | Yes — see Q1 |
| `transaction_hash` (both tables) | 47.2 | 18% | No, it is the join key |
| addresses (from/to/token) | 47.6 | 18% | No |
| everything else | ~23 | 8% | No |

Two of those five lines are optional, and together they are **56% of the dataset**.

---

## 2. Cost

| Line | Per month | Note |
|---|---|---|
| Server (Hetzner AX52-class, 64 GB RAM, NVMe) | **$70–130** | **$0 if the institution provides one** |
| R2 object storage, 270 GB | $4 | Egress is free, which is why R2 and not S3/GCS |
| Cloudflare CDN | $0 | Free tier |
| BigQuery ingest | **$0** | Measured; fits inside the free 1 TiB/month |
| **Total, rented server** | **~$75–135** | |
| **Total, institutional server** | **~$4–5** | |

One-time: the year-long backfill scans 1.38 TiB, which is **free** if it spans two calendar
months and ~$2.36 if run inside one.

**The server is 95% of the bill.** Every other line is rounding error. This means the
hosting conversation is worth more than every technical optimization combined, and it is a
question for the institution, not an engineering decision.

The BigQuery line deserves a note: it was budgeted at $10–20/month, but measurement showed
a day-sized time filter prunes 24.6× (86.51 GB for a month of transactions, 3.51 GB for a
day). The daily job reads only the new day rather than re-reading the month, and the
recurring ingest cost is therefore zero. The one hazard is a query that loses its time
filter — that scans ~5.7 TB and costs ~$32 per run — which the pipeline's dry-run guard
already refuses to let happen.

---

## 3. Questions for the research group

These are the decisions we cannot make for you. Each one is phrased so it can be forwarded
as-is. Costs are per year of data.

### Q1. Do you need the ECDSA signature columns? — worth 76 GB/year

`r`, `s`, `v`, `y_parity` are the cryptographic signature of each transaction. They are
random bytes, so they do not compress, and they are **28% of the entire dataset**.

They are used for: detecting nonce or nonce-`k` reuse, signature malleability studies,
wallet-fingerprinting, and clustering bot operators by signing implementation. If nobody is
doing that kind of work, they are dead weight.

- **Keep everywhere:** 270 GB archive, 409 GB disk.
- **Keep in the archive, drop from the live database:** 270 GB archive, 333 GB disk.
  Researchers who need signatures download Parquet; the explorer and API never serve them.
- **Drop entirely:** 194 GB archive, 333 GB disk.

*Our recommendation: keep in the archive, drop from the live database.* It costs almost
nothing to keep the cold copy, and no explorer user will ever ask to sort by `s`.

### Q2. Do you need full calldata, or just the function selector? — worth up to 75 GB/year

`input` is the raw data sent to a contract. Its **first 4 bytes are the function selector**
(which method was called); the rest is the encoded arguments.

A great deal of research only needs the selector — "how many `swap` calls were there",
"which contracts are being called at all". Decoding arguments needs the whole thing.

- **Full calldata everywhere:** as costed above.
- **Full calldata in the archive, selector only in the live database:** −75 GB of NVMe.
  The explorer already fetches calldata lazily per row today, so this changes nothing a
  user would notice.
- Taking both Q1 and Q2 this way puts the live database at **257 GB/year instead of 409**,
  a 37% reduction, while the published archive still contains every byte.

*Our recommendation: full calldata in the archive, selector plus lazy fetch in the live
database.* Nothing is lost and the expensive disk shrinks by more than a third.

### Q3. **Do you need to know whether a transaction succeeded?**

This one is not a cost question, and it is the most important item here.

The three source tables we are using **do not carry transaction status**. There is no
success/failure flag, and no `gas_used` — we have `gas`, which is the *limit* the sender
set, not the amount actually consumed. Also absent: `effective_gas_price`,
`cumulative_gas_used`, and the `contract_address` created by a deployment.

Consequences, if we ship as currently specified:

- A **reverted** transaction is indistinguishable from a successful one. It appears in the
  data, with its value, having moved nothing.
- **Actual fees cannot be computed.** Fee = `gas_used × effective_gas_price`, and we have
  neither factor. `gas × gas_price` is an upper bound that is often wildly wrong.
- Contract deployments show `to_address` as null with no way to learn the created address.

If any of that matters, we need to add the receipts/logs source to the pipeline. That is a
real but bounded piece of work, and it is far cheaper to decide now than after a backfill.

*Our recommendation: assume you need it and confirm.* "Did this transaction actually
succeed, and what did it really cost" is a question almost every downstream analysis
eventually asks.

### Q4. Which block-level fields do you want? — cheap, ask for everything plausible

The `blocks` table is only ~2.6 M rows a year, so extra columns here cost very little. We
currently take four (`block_number`, `block_timestamp`, `block_hash`, `transaction_count`)
and are leaving these on the table:

| Field | Why it might matter |
|---|---|
| `base_fee_per_gas` | EIP-1559 fee-market analysis. Very commonly wanted. |
| `gas_used`, `gas_limit` | Block utilization and congestion |
| `miner` | Proposer / builder identity, MEV research |
| `extra_data` | Builders tag blocks here; used to identify who built them |
| `withdrawals` | Post-Shapella staking flows |
| `size` | Bandwidth and block-space studies |
| `difficulty`, `total_difficulty` | Pre-merge periods only |
| `parent_hash`, state/receipts roots, `logs_bloom` | Chain-integrity verification |

*Our recommendation: take all of the first six.* The cost is on the order of a gigabyte a
year and adding a column later means re-running the backfill.

### Q5. Which year, and is one year the right scope?

The source covers **block 0 to head**, so any window is available — five years needs no new
data source, only more disk and time.

For a citable research dataset a **fixed calendar window** (e.g. 2026-01-01 to 2026-12-31)
is usually better than a trailing 12 months, because a moving window makes results
irreproducible and a citation ambiguous. A fixed window plus a separately-versioned "recent"
extension is the common compromise.

*Our recommendation: fix the window, version it, state it in the citation.*

### Q6. Token metadata coverage

Token quantities are integers scaled by each contract's `decimals`, which the source
dataset does not carry. The current build fills this from a separate BigQuery token export
and reaches **46% of transfer rows** — and the gap is not random: USDC is missing entirely
and is 25% of all transfers by itself.

Do you need better coverage (which means bringing in an external token registry), or is
"show the raw integer when we cannot be sure" acceptable? Guessing a wrong scale is off by
orders of magnitude, which is worse than showing nothing.

---

## 4. Question for the institution

**Is there a server with 1 TB of local NVMe (3 TB if we go to five years), 32–64 GB of RAM,
and a persistent network connection?**

A standalone version of this ask, written for whoever administers research infrastructure —
including what to ask them, what to watch out for, and how to judge what they offer — is in
[`2026-09-09-server-requirements.md`](2026-09-09-server-requirements.md).

If yes, the project runs at **~$4/month**. If no, a rented dedicated server is
**$70–130/month**. That single answer is 95% of the running cost.

Not needed: GPUs, high core counts, or redundancy. The database is rebuildable from object
storage, so the failure mode is downtime, not data loss.

---

## 5. What is already settled

| Decision | Answer | How |
|---|---|---|
| Storage format | Parquet, zstd, monthly partitions | measured |
| Hex vs binary encoding | **Hex** — costs only 6.7% (270 vs 252 GB) | measured both |
| 256-bit number format | Decimal strings | `DECIMAL(76,0)` proved impossible; BigQuery's own `BIGNUMERIC` also cannot hold 78 digits |
| Database engine | ClickHouse, one server | measured on a real load |
| Export query correctness | All 42 columns verified against the live schema | no changes needed |
| Ingest cost | ~$0/month | measured |
| Data freshness | Head is ~2 hours behind live | measured |
| Block rate | 12.04 s/block, 2.62 M blocks/year | measured |

## 6. What is still unproven

- **Query latency at scale.** Everything so far ran on 100 blocks, which fits in memory.
  The performance targets need a real backfill before anyone should believe them.
- ~~The `v`/`y_parity` string format.~~ Resolved: DuckDB's cast parses `0x` prefixes
  natively, so the repack step handles hex and decimal identically. Covered by tests.
- **Behaviour at a billion rows**: bloom-filter selectivity, merge pressure, address-index
  size. All flagged as exit criteria for the first backfill.
