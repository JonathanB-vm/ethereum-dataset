# Server requirements — what to ask the institution for

Date: 2026-09-09
Audience: whoever administers research infrastructure. Written to be forwarded as-is.
Context: [decision brief](2026-09-09-decision-brief.md)

We need one Linux machine to host a columnar database and a small API for a public
Ethereum research dataset. This is the only meaningful running cost in the project: on
institutional hardware the whole thing costs about **$4/month**, and rented it is
**$70–130/month**.

---

## The ask, in one paragraph

> One Linux server, running continuously, with **local NVMe SSD storage** — 1 TB, or 500 GB
> at minimum — plus 32–64 GB RAM and 4–8 CPU cores. It runs a ClickHouse database and a
> small web service in Docker. It needs outbound internet access, and inbound HTTPS on port
> 443 if the explorer is to be reachable by other researchers. It does **not** need a GPU,
> redundancy, or backups.

---

## Sizing

| | One year of data | Five years |
|---|---|---|
| Database on disk | 409 GB | ~1.6–2.1 TB |
| **Disk to provision** | **1 TB** (500 GB absolute minimum) | **3 TB** |
| RAM | 32 GB minimum, 64 GB comfortable | 64–128 GB |
| CPU | 4 cores minimum, 8 comfortable | 8–16 |

The gap between 409 GB of data and 1 TB of disk is deliberate. ClickHouse merges data parts
in the background, and a merge temporarily needs free space alongside the parts it is
combining. Running a columnar database at 90% full is how you get a wedged server.

Two of the six research-group decisions could cut the database to **257 GB/year** by keeping
the two heaviest columns in cloud object storage rather than on this disk. So 1 TB is likely
generous for one year, which is the right way to be wrong.

---

## Why NVMe specifically

This is the requirement most likely to be misunderstood, so it is worth being precise.

The database answers queries by doing **many small random reads** — it holds a sparse index,
jumps to the relevant chunks, and reads those. It does not stream files start to finish.
That access pattern is dominated by *latency per read*, not by sequential throughput, and
storage types differ by orders of magnitude here:

| Storage | Random reads/sec | Latency | Verdict |
|---|---|---|---|
| Spinning disk (HDD) | ~100–200 | 5–10 ms | **Unusable.** Queries that should take 100 ms take tens of seconds. |
| SATA SSD | ~50–100k | ~0.1 ms | Workable |
| **NVMe SSD** | ~500k–1M | ~0.05 ms | **What we want** |
| Network storage (NFS, SAN, Ceph) | varies, often capped | 0.5–2 ms+ | **Usually a trap** — see below |

A dataset of this size does not fit in RAM, so most queries genuinely touch the disk. That
is the whole reason the storage type matters more than the CPU.

---

## Questions to ask, and why

**1. Is the storage physically attached to the machine, or over the network?**

This is the single most important question. "We have 2 TB of storage" very often means a
shared NFS mount or a SAN volume. ClickHouse on network-attached storage is materially
slower and, on NFS specifically, can be unreliable under its file locking patterns. Ask for
**local NVMe**. If the only option is network storage, say so and we will re-plan rather
than discover it during the backfill.

**2. Is it a physical machine, a VM, or a container?**

Any is fine, provided the disk is local NVMe and the VM's IOPS are not throttled. Some
virtualization platforms cap IOPS per VM well below what the underlying hardware can do,
which produces exactly the symptom NVMe was chosen to avoid.

**3. Does it run continuously, or is it a scheduled/batch environment?**

This must be a **persistent service**, up 24/7. An HPC cluster where jobs are queued,
time-limited, or preemptible does not fit — the database has to be there when a researcher
opens the page.

**4. Can we get root, or at least Docker?**

We deploy ClickHouse and a small API as containers. Docker (or Podman) is enough; full root
is convenient but not required.

**5. What network access is possible?**

- **Outbound HTTPS** is required — the daily job pulls new data from Google BigQuery and
  cloud object storage.
- **Inbound HTTPS on 443** is required *only if* the explorer should be reachable by people
  outside the institution. This is often the hardest part institutionally (firewall rules,
  a DMZ, a security review), so raise it early. If inbound is impossible, the database and
  API can still live here while the public site is hosted elsewhere — it just needs to be
  designed that way from the start.

**6. Who administers it, and what is the support expectation?**

Worth knowing whether we can reboot it ourselves, and who to contact if a disk fails.

---

## What we explicitly do NOT need

Saying this up front usually makes the request easier to approve:

- **No GPU.** This is a database, not model training.
- **No backups.** The database is fully rebuildable from the cloud archive, which is
  versioned and checksummed. If this machine dies, we lose availability for a few hours,
  never data. Do not let anyone size a backup solution for 400 GB on our behalf.
- **No redundancy or high availability.** Same reason. One machine is the design.
- **No huge core count.** Storage is the bottleneck, not CPU.
- **No enterprise database licence.** ClickHouse is open source (Apache 2.0).

---

## How to judge what they offer

| If they offer | Verdict |
|---|---|
| Bare metal, local NVMe, 1 TB+ | **Ideal** |
| VM with local NVMe, IOPS not throttled | **Fine** |
| VM on an all-flash SAN | Probably fine — worth a quick benchmark before committing |
| Institutional cloud credits (AWS/Azure/GCP) with SSD volumes | Fine — but check the monthly cost, which can quietly exceed renting a dedicated box |
| VM backed by NFS or spinning disks | **Not suitable** for the database. Tell us and we re-plan. |
| HPC / batch cluster allocation | **Not suitable** — not a persistent service |
| "We can give you 200 GB" | Too small for a year. Ask what it would take to reach 1 TB. |

On RAID, if it comes up: two NVMe drives striped (RAID 0) gives us speed and capacity, and
is a reasonable choice here precisely because the data is rebuildable. Mirroring (RAID 1) is
fine too, it just halves the usable space. We do not need either.

---

## If the answer is no

The fallback is a rented dedicated server. A Hetzner AX52 (Ryzen 7 7700, 64 GB RAM,
2×1 TB NVMe) is roughly €64/month and exceeds every requirement above. That is the
$70–130/month line in the budget, and the project is entirely viable on it — it just means
a recurring bill instead of ~$4/month.

There is no need to over-negotiate. If institutional hardware is awkward to obtain, renting
is a perfectly good outcome and cheap by research-infrastructure standards.

---

## One honest caveat

The performance targets behind these numbers have **not** yet been validated at full scale.
Everything measured so far ran on a 100-block sample, which fits in memory. The storage
sizing is measured and reliable; the RAM and CPU figures are conventional for ClickHouse at
this data size rather than something we have proven. If the machine turns out to be
generous, that is the direction to err in — the first real backfill is what will tell us.
