# Load test — single process vs. cluster workers

`npm run loadtest` starts an in-memory MongoDB, the real API and autocannon on the
same machine (see `scripts/loadtest.js`). `--workers N` (or `--workers max`,
`LOADTEST_WORKERS=N`) runs N API workers on one port through `node:cluster`, the
way PM2 cluster mode does on the server.

```bash
npm run loadtest                                  # 1 worker (baseline)
LOADTEST_CONNECTIONS=25 npm run loadtest -- --workers 4
```

## Results, 16 Oct 2026 (Windows dev laptop, 8 logical CPUs, Node 24.18)

25 connections, 10–15 s per scenario. Values are req/s (p99 ms).

**Caveat:** during these runs the laptop was already at 100 % CPU from other
software (Windows Update, antivirus, browsers). Even `/health`, which is pure
Node work, did not get faster with more workers, so the CPU, not the API
process, was the limit. The same scenarios ran at roughly 150–180 req/s (heavy
reads) and ~3,000 req/s (`/health`) on one worker on a quiet machine the day
before. To compare fairly, the 1- and 4-worker runs were interleaved (pair a,
then pair b) so both saw the same background load.

| Scenario | 1 w (a) | 4 w (a) | 1 w (b) | 4 w (b) |
|---|---|---|---|---|
| GET /health | 658 (163) | 1165 (92) | 1076 (82) | 1187 (61) |
| GET /me (MR) | 39 (3169) | 158 (496) | 135 (634) | 97 (1023) |
| GET /doctors — Master MCL | 31 (5886) | 78 (1271) | 40 (2214) | 63 (1602) |
| GET /doctors?q= search | 60 (784) | 60 (948) | 45 (2114) | 60 (931) |
| GET /mrs/me/mcl | 50 (1659) | 118 (949) | 95 (833) | 103 (1221) |
| GET /doctors/:id/slots | 61 (1812) | 89 (951) | 100 (816) | 65 (880) |
| GET /doctors/me/banners | 65 (787) | 114 (1300) | 100 (709) | 63 (651) |
| GET /appointments (doctor) | 132 (827) | 170 (438) | 137 (585) | 68 (1060) |
| GET /reports/summary | 175 (860) | 178 (427) | 148 (1644) | 149 (447) |
| GET /plans | 181 (918) | 96 (1507) | 258 (320) | 96 (628) |
| POST /appointments (writes) | 50 (1094) | 38 (1101) | 92 (515) | 50 (1207) |

An 8-worker run did worse than 4 (`/health` 440 req/s): the load generator and
MongoDB share the same 8 CPUs, so 8 API workers oversubscribe them.

**Reading:** on a saturated machine, more workers help the heaviest reads
(Master MCL, MR's MCL list) and cut p99 in most scenarios, but the results are
noisy and not a clean speed-up. MongoDB (one in-memory `mongod`) also limits the
read-heavy endpoints, so extra API workers alone cannot scale them linearly.
Re-run on an idle machine, or on the VPS against a copy of the data, before
picking `API_INSTANCES`.

## Sizing on the VPS

MongoDB, Redis, Nginx and the API share the VPS. Start with `API_INSTANCES` =
CPUs − 1 (e.g. `2` on a 2–4 vCPU plan) and raise it while `pm2 monit` shows the
workers CPU-bound and `mongod` has headroom.
