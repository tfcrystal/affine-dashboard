/**
 * Script to update all model sizes in cache-model-size.json
 * This script:
 * 1. Gets all UIDs from the rank data
 * 2. For each UID, fetches the model size with a 1 second delay to avoid 429 errors
 * 3. Updates the cache-model-size.json file
 * 
 * Run this script every 3 hours to keep model sizes up to date.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { loadModelSizeCache, setModelSizesInCache } from '../utils/modelSizeCache';
import { parseRankData } from '../utils/parseRankData';

const execAsync = promisify(exec);
const REPORTS_DIR = '/root/bittensor/affine-cortex/reports';

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get the latest date folder name from existing folders
 */
async function getLatestDateFolder(): Promise<string | null> {
  try {
    const entries = await readdir(REPORTS_DIR, { withFileTypes: true });
    const dateFolders = entries
      .filter(e => e.isDirectory() && /^\d{8}$/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse();
    return dateFolders.length > 0 ? dateFolders[0] : null;
  } catch {
    return null;
  }
}

/**
 * Load the latest successful report to get all UIDs
 */
async function loadLatestSuccessfulReport(): Promise<string | null> {
  try {
    // First, try to find reports in date folders
    const latestDateFolder = await getLatestDateFolder();
    if (latestDateFolder) {
      const dateFolderPath = path.join(REPORTS_DIR, latestDateFolder);
      const files = await readdir(dateFolderPath);
      const candidates = files
        .filter(f => f.endsWith('.txt'))
        .map(f => path.join(dateFolderPath, f));

      const withStat = await Promise.all(
        candidates.map(async p => {
          try {
            const s = await stat(p);
            return { p, mtimeMs: s.mtimeMs, size: s.size };
          } catch {
            return null;
          }
        })
      );

      const sorted = withStat
        .filter((x): x is { p: string; mtimeMs: number; size: number } => !!x && x.size > 50)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const c of sorted) {
        try {
          const content = await readFile(c.p, 'utf-8');
          // Check if it looks like a success report
          const head = content.slice(0, 500);
          if (!head.startsWith('Error:') && !head.includes('Forbidden') && 
              head.includes('MINER RANKING TABLE') && head.includes('Hotkey')) {
            return content;
          }
        } catch {
          continue;
        }
      }
    }

    // Fallback: check root reports directory for old files (backward compatibility)
    const files = await readdir(REPORTS_DIR);
    const candidates = files
      .filter(f => f.endsWith('.txt') && !f.includes('/'))
      .map(f => path.join(REPORTS_DIR, f));

    const withStat = await Promise.all(
      candidates.map(async p => {
        try {
          const s = await stat(p);
          return { p, mtimeMs: s.mtimeMs, size: s.size };
        } catch {
          return null;
        }
      })
    );

    const sorted = withStat
      .filter((x): x is { p: string; mtimeMs: number; size: number } => !!x && x.size > 50)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const c of sorted) {
      try {
        const content = await readFile(c.p, 'utf-8');
        // Check if it looks like a success report
        const head = content.slice(0, 500);
        if (!head.startsWith('Error:') && !head.includes('Forbidden') && 
            head.includes('MINER RANKING TABLE') && head.includes('Hotkey')) {
          return content;
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get model name for a UID using get_commit_batch.py
 */
async function getModelNameForUID(uid: number): Promise<string | null> {
  try {
    const command = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_commit_batch.py ${uid}"`;
    const { stdout } = await execAsync(command, { timeout: 15000 });
    const result = JSON.parse(stdout);
    const commitData = result[uid];
    return commitData?.model ?? null;
  } catch (error) {
    console.error(`Failed to get model name for uid=${uid}:`, error);
    return null;
  }
}

/**
 * Get model size for a UID using get_modelsize_batch.py
 */
async function getModelSizeForUID(uid: number): Promise<number | null> {
  try {
    const command = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_modelsize_batch.py ${uid}"`;
    const { stdout } = await execAsync(command, { timeout: 30000 });
    const result = JSON.parse(stdout);
    const firstKey = Object.keys(result)[0];
    const resultData = result[firstKey];
    return resultData?.modelSizeGB ?? null;
  } catch (error) {
    console.error(`Failed to get model size for uid=${uid}:`, error);
    return null;
  }
}

/**
 * Main function to update all model sizes
 */
async function updateAllModelSizes(): Promise<void> {
  console.log('====>Starting model size update process...');
  console.log(`====>Time: ${new Date().toISOString()}`);
  
  // Load the latest report to get all UIDs
  const reportContent = await loadLatestSuccessfulReport();
  if (!reportContent) {
    console.error('====>Failed to load latest report');
    return;
  }
  
  // Parse report using the existing utility
  const parsed = parseRankData(reportContent);
  const uids = parsed.models.map(m => m.uid);
  console.log(`====>Found ${uids.length} UIDs in report`);
  
  if (uids.length === 0) {
    console.error('====>No UIDs found in report');
    return;
  }
  
  // Load current cache
  const cache = await loadModelSizeCache();
  console.log(`====>Current cache has ${Object.keys(cache).length} entries`);
  
  // Track updates
  const updates: Record<string, number> = {};
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  
  // Process each UID with 1 second delay to avoid 429 errors
  for (let i = 0; i < uids.length; i++) {
    const uid = uids[i];
    console.log(`====>Processing UID ${uid} (${i + 1}/${uids.length})...`);
    
    try {
      // Get model name first
      const modelName = await getModelNameForUID(uid);
      
      if (!modelName) {
        console.log(`====>  No model name found for UID ${uid}, skipping`);
        skippedCount++;
        await sleep(1000); // Still wait 1 second to maintain rate limit
        continue;
      }
      
      // Check if we already have this model in cache (optional: skip if exists)
      // Actually, we want to update all models, so we'll fetch anyway
      
      // Get model size
      const modelSize = await getModelSizeForUID(uid);
      
      if (modelSize !== null && modelSize !== undefined) {
        updates[modelName] = modelSize;
        console.log(`====>  UID ${uid} -> ${modelName}: ${modelSize} GB`);
        successCount++;
      } else {
        console.log(`====>  UID ${uid} -> ${modelName}: No size found`);
        errorCount++;
      }
      
      // Wait 1 second before processing next UID to avoid 429 errors
      if (i < uids.length - 1) {
        await sleep(1000);
      }
    } catch (error) {
      console.error(`====>  Error processing UID ${uid}:`, error);
      errorCount++;
      // Still wait 1 second even on error
      if (i < uids.length - 1) {
        await sleep(1000);
      }
    }
  }
  
  // Update cache with all new sizes
  if (Object.keys(updates).length > 0) {
    console.log(`====>Updating cache with ${Object.keys(updates).length} new/updated model sizes...`);
    await setModelSizesInCache(updates);
    console.log(`====>Cache updated successfully`);
  }
  
  console.log(`====>Update complete!`);
  console.log(`====>  Success: ${successCount}`);
  console.log(`====>  Errors: ${errorCount}`);
  console.log(`====>  Skipped: ${skippedCount}`);
  console.log(`====>  Total processed: ${uids.length}`);
}

// Run the update
if (require.main === module) {
  updateAllModelSizes()
    .then(() => {
      console.log('====>Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('====>Script failed:', error);
      process.exit(1);
    });
}

export { updateAllModelSizes };

