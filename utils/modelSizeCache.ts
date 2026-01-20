import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const CACHE_FILE_PATH = path.join(process.cwd(), 'cache-model-size.json');

export interface ModelSizeCache {
  [modelFullName: string]: number; // modelFullName -> modelSizeGB (as number)
}

/**
 * Convert a value (string with "GB" or number) to a number
 */
function parseModelSize(value: string | number): number | null {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    // Handle format like "16.40 GB" or "16.40"
    const cleaned = value.trim().replace(/\s*GB\s*$/i, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Load the model size cache from disk
 * Handles both old format (strings like "16.40 GB") and new format (numbers)
 */
export async function loadModelSizeCache(): Promise<ModelSizeCache> {
  try {
    const content = await readFile(CACHE_FILE_PATH, 'utf-8');
    const rawCache: Record<string, string | number> = JSON.parse(content);
    const cache: ModelSizeCache = {};
    
    // Convert all values to numbers, handling both old and new formats
    for (const [modelFullName, value] of Object.entries(rawCache)) {
      const parsed = parseModelSize(value);
      if (parsed !== null) {
        cache[modelFullName] = parsed;
      }
    }
    
    // If we converted any values, save the cleaned version back (non-blocking)
    const needsUpdate = Object.keys(rawCache).some(key => typeof rawCache[key] === 'string');
    if (needsUpdate) {
      try {
        await saveModelSizeCache(cache);
      } catch (saveError) {
        console.warn('Failed to save converted cache format (non-critical):', saveError);
        // Continue with the converted cache in memory even if save fails
      }
    }
    
    return cache;
  } catch (error: any) {
    // If file doesn't exist or is invalid, return empty cache
    if (error.code === 'ENOENT') {
      return {};
    }
    console.error('Failed to load model size cache:', error);
    return {};
  }
}

/**
 * Save the model size cache to disk
 */
export async function saveModelSizeCache(cache: ModelSizeCache): Promise<void> {
  try {
    await writeFile(CACHE_FILE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save model size cache:', error);
    throw error;
  }
}

/**
 * Get model size from cache
 */
export async function getModelSizeFromCache(modelFullName: string): Promise<number | null> {
  const cache = await loadModelSizeCache();
  return cache[modelFullName] ?? null;
}

/**
 * Add or update model size in cache
 */
export async function setModelSizeInCache(modelFullName: string, modelSizeGB: number): Promise<void> {
  const cache = await loadModelSizeCache();
  cache[modelFullName] = modelSizeGB;
  await saveModelSizeCache(cache);
}

/**
 * Batch get model sizes from cache
 */
export async function getModelSizesFromCache(modelFullNames: string[]): Promise<Record<string, number | null>> {
  const cache = await loadModelSizeCache();
  const result: Record<string, number | null> = {};
  for (const modelFullName of modelFullNames) {
    result[modelFullName] = cache[modelFullName] ?? null;
  }
  return result;
}

/**
 * Batch set model sizes in cache
 */
export async function setModelSizesInCache(updates: Record<string, number>): Promise<void> {
  const cache = await loadModelSizeCache();
  for (const [modelFullName, modelSizeGB] of Object.entries(updates)) {
    cache[modelFullName] = modelSizeGB;
  }
  await saveModelSizeCache(cache);
}

