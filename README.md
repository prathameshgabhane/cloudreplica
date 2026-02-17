# Cloud-Compare Pricing Pipeline

### Automated Multi‑Cloud Price Fetching, Aggregation & Publishing

This repository provides a **fully automated pricing pipeline** that fetches on‑demand VM/instance prices from AWS EC2, Azure Virtual Machines, and Google Cloud Compute Engine, normalizes them, and publishes a unified flat-price dataset used by the built‑in Cloud Compare UI hosted via GitHub Pages.

## Repository Structure
```
cloud-compare/
├── scripts/
│   ├── providers/
│   ├── aggregate/
│   └── lib/
├── data/
├── docs/
│   ├── data/
│   └── ui/
└── .github/workflows/
```

## Pipeline Overview
- Fetch AWS, Azure, GCP prices individually.
- Normalize and prepare compute pricing.
- Merge into a unified **flat schema**.
- Publish results inside `docs/data/` for lightning‑fast UI.

## Unified Flat Schema
```json
{
  "meta": { "os": [...], "vcpu": [...], "ram": [...] },
  "aws": [...],
  "azure": [...],
  "gcp": [...],
  "generatedAt": "timestamp"
}
```

## GitHub Actions Workflows
- `update-aws.yml`
- `update-azure.yml`
- `update-gcp.yml`
- `update-all.yml` (main orchestrator)

## UI
Served from `docs/` via GitHub Pages. Loads real‑time pricing from:
```
./data/prices.json?v=<cachebuster>
```

