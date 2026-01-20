# Model Size Update Scripts

This directory contains scripts to automatically update model sizes in the `cache-model-size.json` file.

## Overview

Model sizes on HuggingFace can change randomly when model owners update their repositories. To ensure the dashboard always shows correct model size information, these scripts automatically refresh the cache every 3 hours.

## Scripts

### `update-model-sizes.ts`

Main script that:
1. Loads the latest rank report to get all UIDs
2. For each UID:
   - Gets the model name using `get_commit_batch.py`
   - Fetches the model size using `get_modelsize_batch.py`
   - Waits 1 second between requests to avoid 429 (rate limit) errors
3. Updates the `cache-model-size.json` file with all new/updated sizes

**Usage:**
```bash
npm run update-model-sizes
```

### `schedule-model-size-updates.ts`

Scheduler script that runs `update-model-sizes.ts` every 3 hours automatically. This script:
- Runs the update immediately on startup
- Then schedules updates every 3 hours (10,800,000 milliseconds)
- Runs continuously until stopped

**Usage:**
```bash
npm run schedule-model-sizes
```

## PM2 Integration

The scheduler is configured in `ecosystem.config.js` to run as a separate PM2 process named `model-size-scheduler`. 

**To start the scheduler with PM2:**
```bash
cd /root/bittensor/affine-cortex
pm2 start ecosystem.config.js
```

**To restart the scheduler:**
```bash
pm2 restart model-size-scheduler
```

**To stop the scheduler:**
```bash
pm2 stop model-size-scheduler
```

**To view logs:**
```bash
pm2 logs model-size-scheduler
```

## How It Works

1. **Rate Limiting**: The script processes one UID per second to avoid hitting HuggingFace API rate limits (429 errors).

2. **Error Handling**: If a model size cannot be fetched for a particular UID, the script logs the error and continues with the next UID.

3. **Cache Updates**: Only successfully fetched model sizes are added to the cache. The cache is updated in batch at the end of each run.

4. **Logging**: The script provides detailed console output showing:
   - Progress (current UID being processed)
   - Success/error counts
   - Model name and size for each successful fetch

## Schedule

- **Update Interval**: Every 3 hours
- **First Run**: Immediately when the scheduler starts
- **Processing Time**: Approximately 1 second per UID (e.g., 200 UIDs = ~3.3 minutes)

## Dependencies

- `tsx`: TypeScript execution (added to devDependencies)
- Python scripts: `get_commit_batch.py` and `get_modelsize_batch.py` (must be in `/root/bittensor/affine-cortex/`)

