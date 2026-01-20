# Dominated Web - Model Dominance Rankings

A Next.js web application to display Bittensor Affine model rankings with dominance analysis.

## Features

- Fetches latest rank data using `af get-rank` command
- Rate limiting: 2-minute cooldown between refreshes (prevents server overload)
- Calculates dominance relationships between models
- Displays collapsible dominator details for each model
- Shows model scores, weights, and points
- Real-time refresh with cached fallback

## Setup

1. Navigate to the project directory:
```bash
cd root/bittensor/affine-cortex/dominated-web
```

2. Install dependencies:
```bash
npm install
```

3. Build the application:
```bash
npm run build
```

## Running with PM2

1. Start the application:
```bash
cd root/bittensor/affine-cortex/dominated-web
pm2 start ecosystem.config.js
```

2. View logs:
```bash
pm2 logs dominated-web
```

3. Stop the application:
```bash
pm2 stop dominated-web
```

4. Restart the application:
```bash
pm2 restart dominated-web
```

5. View status:
```bash
pm2 status
```

## Development

Run in development mode:
```bash
npm run dev
```

The application will be available at `http://localhost:3000`

## Configuration

The API route is configured to:
- Execute `af get-rank` command from `root/bittensor/affine-cortex` directory
- Save reports to `root/bittensor/affine-cortex/reports/` directory
- Use timestamp format: `DDMMYYYY-HH:MM` for report filenames

If you need to change these paths, edit `/pages/api/rank.ts`:
- `REPORTS_DIR` constant for reports directory
- Command execution path in the `execAsync` call

## API

- `GET /api/rank` - Fetches rank data
  - Query parameter: `refresh=true` to force refresh (bypasses rate limiting)
  - Returns cached data if within 2-minute rate limit window
  - Automatically falls back to cached data if fetch fails

## Dominance Rules

A model is considered **dominated** using this simplified “older-first Pareto dominance” rule:

1. Only miners with an **older** `FirstBlk` (strictly lower) are considered as dominator candidates.
2. A candidate dominates a target if, for **every** environment score column, the candidate’s score is **≥** the target’s score.
   - If the target has a higher score in **any** environment, that candidate does **not** dominate.
3. Environments are only comparable when **both** miners have samples (`/N` in the report, and \(N>0\)); if either miner is missing data for an environment, dominance fails for that candidate.

Notes:
- The bracketed value in the report (e.g. `93.52[93.11]/911`) is displayed in the UI but is **not** used for dominance decisions.
- To avoid unfinished miners being listed as dominators, this app only counts a miner as a **possible dominator** if:
  - it is **eligible** (`V` column is `✓`)
  - it is **active** (`weight > 0` in the report)
  - it is **complete** (no score cell ends with `!`)

## Troubleshooting

- If `af get-rank` command is not found, ensure it's in your PATH or update the command in `/pages/api/rank.ts`
- If reports directory doesn't exist, create it: `mkdir -p root/bittensor/affine-cortex/reports`
- Check PM2 logs for errors: `pm2 logs dominated-web --err`
