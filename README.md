# Cloud-Compare Pricing Pipeline

### Automated Multi‑Cloud Price Fetching, Aggregation & Publishing

This repository contains a fully automated pipeline that fetches **AWS EC2** and **Azure VM** on‑demand prices, merges them into a unified format, and publishes the output for use in a cloud cost comparison UI.

The entire system runs on **GitHub Actions**, is fully scheduled, supports manual runs, and ensures your published site always has **fresh, consistent cloud prices**.

## Repository Structure
```
cloud-compare/
│
├── scripts/
│   ├── providers/
│   │   ├── aws.fetch.js
│   │   └── azure.fetch.js
│   ├── aggregate/
│   │   └── build-prices.js
│   └── lib/
│       ├── common.js
│       ├── aws.js
│       └── azure.js
│
├── data/
│   ├── aws/aws.prices.json
│   ├── azure/azure.prices.json
│   └── prices.json
│
├── docs/
│   └── data/
│
└── .github/workflows/
    ├── update-aws.yml
    ├── update-azure.yml
    └── update-all.yml
```

## How the Pipeline Works

### 1. AWS Fetcher
Fetches EC2 PAYG pricing, filters compute SKUs, normalizes vCPU/RAM, dedupes cheapest per instance/OS, and writes:
```
data/aws/aws.prices.json
```

### 2. Azure Fetcher
Fetches Azure Retail VM prices, filters non-hourly, excludes promo/spot/devtest, categorizes families, enriches from Resource SKUs, and writes:
```
data/azure/azure.prices.json
```

### 3. Aggregator
Merges AWS + Azure into unified schema:
```
data/prices.json
```

### 4. Publishing for GitHub Pages
Copies final JSON files into:
```
docs/data/
```
Your UI reads from these paths.

## GitHub Actions Overview

### update-azure.yml
- Azure login via OIDC
- Fetch Azure prices
- Fetch AWS prices
- Aggregate
- Publish
- Commit

### update-aws.yml
- Fetch AWS prices
- Fetch Azure prices
- Aggregate
- Publish
- Commit

### update-all.yml
Runs Azure → AWS in sequence (scheduled every 6 hours).

## Troubleshooting
- If prices don't change → ensure both providers fetched before aggregator
- If UI stale → check `docs/data/` updates
- Azure missing vCPU/RAM → ARM token required

## Summary
This pipeline keeps cloud pricing data fresh, normalized, and published for your Cloud Compare UI.