import { NextApiRequest, NextApiResponse } from 'next';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, stat } from 'fs/promises';
import { parseRankData, calculateDominance } from '../../utils/parseRankData';
import { getModelSizesFromCache, setModelSizesInCache } from '../../utils/modelSizeCache';
import path from 'path';

const execAsync = promisify(exec);

// Rate limiting: store last fetch time
let lastFetchTime: number = 0;
const MIN_FETCH_INTERVAL = 2 * 60 * 1000; // 2 minutes in milliseconds
let cachedData: any = null;
let cachedTimestamp: string = '';
let cachedCurrentBlock: number | undefined = undefined;

// Reports directory - adjust this path as needed
const REPORTS_DIR = '/root/bittensor/affine-cortex/reports';
const MY_PREFIX_PATH = '/root/bittensor/affine-cortex/product-web/my_model_prefix.json';
const TEAM_PREFIX_PATH = '/root/bittensor/affine-cortex/product-web/team_model_prefix.json';

type MyPrefixConfig = { prefixes?: string[] };

async function loadMyPrefixes(): Promise<string[]> {
  try {
    const raw = await readFile(MY_PREFIX_PATH, 'utf-8');
    const parsed: MyPrefixConfig = JSON.parse(raw);
    const prefixes = Array.isArray(parsed.prefixes) ? parsed.prefixes : [];
    return prefixes.filter(p => typeof p === 'string' && p.trim().length > 0).map(p => p.trim());
  } catch {
    return [];
  }
}

async function loadTeamPrefixes(): Promise<string[]> {
  try {
    const raw = await readFile(TEAM_PREFIX_PATH, 'utf-8');
    console.log('====>Team model prefixes raw:', raw);
    const parsed: MyPrefixConfig = JSON.parse(raw);
    const prefixes = Array.isArray(parsed.prefixes) ? parsed.prefixes : [];
    return prefixes.filter(p => typeof p === 'string' && p.trim().length > 0).map(p => p.trim());
  } catch {
    return [];
  }
}

function looksLikeSuccessReport(content: string): boolean {
  const head = content.slice(0, 500);
  if (head.startsWith('Error:')) return false;
  if (head.includes('Forbidden')) return false;
  return head.includes('MINER RANKING TABLE') && head.includes('Hotkey') && head.includes('|');
}

async function loadLatestSuccessfulReport(): Promise<{ reportPath: string; content: string } | null> {
  try {
    const files = await readdir(REPORTS_DIR);
    const candidates = files
      .filter(f => f.endsWith('.txt'))
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
        if (looksLikeSuccessReport(content)) {
          return { reportPath: c.p, content };
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const now = Date.now();
  const forceRefresh = req.query.refresh === 'true';
  
  // Check rate limiting
  if (!forceRefresh && cachedData && (now - lastFetchTime) < MIN_FETCH_INTERVAL) {
    // If we have an older cached payload (from before currentBlock was added),
    // try to recover currentBlock from the cached report file name.
    if (cachedCurrentBlock === undefined && cachedTimestamp) {
      try {
        const p = path.join(REPORTS_DIR, `${cachedTimestamp}.txt`);
        const c = await readFile(p, 'utf-8');
        const parsed = parseRankData(c);
        cachedCurrentBlock = parsed.currentBlock;
        if (!cachedData.currentBlock) cachedData.currentBlock = cachedCurrentBlock;
        if (!cachedData.scoreOrder) cachedData.scoreOrder = parsed.scoreOrder;
      } catch {
        // ignore
      }
    }
    
    // If cached data doesn't have keys or commits, try to fetch them
    let dataToReturn = { ...cachedData };
    if (cachedData.models && cachedData.models.length > 0) {
      const needsKeys = cachedData.models.some((m: any) => !m.coldkey && !m.hotkey);
      const needsCommits = cachedData.models.some((m: any) => !m.chute_id && !m.modelFullName);
      const needsSizes = cachedData.models.some((m: any) => m.modelFullName && (m.modelSizeGB === null || m.modelSizeGB === undefined));
      
      // Load model sizes from cache if we have modelFullNames but missing sizes
      if (needsSizes) {
        try {
          const modelsWithFullName = cachedData.models
            .filter((m: any) => m.modelFullName && (m.modelSizeGB === null || m.modelSizeGB === undefined))
            .map((m: any) => m.modelFullName);
          
          if (modelsWithFullName.length > 0) {
            const cachedSizes = await getModelSizesFromCache(modelsWithFullName);
            dataToReturn.models = cachedData.models.map((model: any) => {
              const modelFullName = model.modelFullName;
              if (modelFullName && cachedSizes[modelFullName] !== null && cachedSizes[modelFullName] !== undefined) {
                return { ...model, modelSizeGB: cachedSizes[modelFullName] };
              }
              return model;
            });
            cachedData = dataToReturn;
          }
        } catch (error: any) {
          console.error('Failed to load model sizes from cache:', error);
          // Continue without cached sizes
        }
      }
      
      if (needsKeys || needsCommits) {
        try {
          const uids = cachedData.models.map((m: any) => m.uid);
          
          if (needsKeys) {
            const keysCommand = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_keys_batch.py ${uids.join(' ')}"`;
            const { stdout } = await execAsync(keysCommand, { timeout: 30000 });
            const keysMap = JSON.parse(stdout);
            dataToReturn.models = cachedData.models.map((model: any) => {
              const keys = keysMap[model.uid] || { coldkey: null, hotkey: null };
              return { ...model, coldkey: keys.coldkey, hotkey: keys.hotkey };
            });
            cachedData = dataToReturn;
          }
          
          if (needsCommits) {
            const commitsCommand = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_commit_batch.py ${uids.join(' ')}"`;
            const { stdout } = await execAsync(commitsCommand, { timeout: 30000 });
            const commitsMap = JSON.parse(stdout);
            dataToReturn.models = (dataToReturn.models || cachedData.models).map((model: any) => {
              const commits = commitsMap[model.uid] || { chute_id: null, model: null };
              return { ...model, chute_id: commits.chute_id, modelFullName: commits.model };
            });
            cachedData = dataToReturn;
          }
          
          // Load model sizes from cache for models that have modelFullName
          try {
            const modelsWithFullName = (dataToReturn.models || cachedData.models)
              .filter((m: any) => m.modelFullName)
              .map((m: any) => m.modelFullName);
            
            if (modelsWithFullName.length > 0) {
              const cachedSizes = await getModelSizesFromCache(modelsWithFullName);
              dataToReturn.models = (dataToReturn.models || cachedData.models).map((model: any) => {
                const modelFullName = model.modelFullName;
                if (modelFullName && cachedSizes[modelFullName] !== null && cachedSizes[modelFullName] !== undefined) {
                  return { ...model, modelSizeGB: cachedSizes[modelFullName] };
                }
                return model;
              });
              cachedData = dataToReturn;
            }
          } catch (error: any) {
            console.error('Failed to load model sizes from cache for cached data:', error);
            // Continue without cached sizes
          }
        } catch (error: any) {
          console.error('Failed to fetch keys/commits for cached data:', error);
          // Continue without keys/commits
        }
      }
    }
    
    // Ensure teamModelPrefixes is loaded even for cached data
    if (!dataToReturn.teamModelPrefixes) {
      const teamModelPrefixes = await loadTeamPrefixes();
      dataToReturn.teamModelPrefixes = teamModelPrefixes;
    }
    
    // Return cached data if within rate limit
    return res.status(200).json({
      ...dataToReturn,
      cached: true,
      timestamp: cachedTimestamp,
      currentBlock: cachedCurrentBlock ?? cachedData.currentBlock,
      nextRefreshAvailable: new Date(lastFetchTime + MIN_FETCH_INTERVAL).toISOString()
    });
  }

  try {
    // Generate timestamp for filename (format: YYYYMMDD-HH:MM), using GMT+9 (Asia/Tokyo)
    const nowDate = new Date();
    // Get the time in JST (GMT+9) by adjusting the time zone offset
    const utc = nowDate.getTime() + (nowDate.getTimezoneOffset() * 60000);
    const jstDate = new Date(utc + (9 * 60 * 60 * 1000));

    const day = String(jstDate.getDate()).padStart(2, '0');
    const month = String(jstDate.getMonth() + 1).padStart(2, '0');
    const year = jstDate.getFullYear();
    const hours = String(jstDate.getHours()).padStart(2, '0');
    const minutes = String(jstDate.getMinutes()).padStart(2, '0');
    const timestamp = `${year}${month}${day}-${hours}:${minutes}`;
    const reportPath = path.join(REPORTS_DIR, `${timestamp}.txt`);

    // Execute af get-rank command
    // Change to the affine directory first, then run the command
    // Use bash explicitly since 'source' is a bash builtin
    const command = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && af get-rank > \\"${reportPath}\\""`;
    await execAsync(command, { timeout: 30000 }); // 30 second timeout

    // Read the report file
    let content = await readFile(reportPath, 'utf-8');
    console.log('====>content length:', content.length);

    // If the freshly generated report is blocked/invalid, fall back to latest successful report.
    let usedReportPath = reportPath;
    let warning: string | undefined;
    if (!looksLikeSuccessReport(content)) {
      const fallback = await loadLatestSuccessfulReport();
      if (fallback) {
        usedReportPath = fallback.reportPath;
        content = fallback.content;
        warning = `Fetch blocked/invalid; using last successful report ${path.basename(usedReportPath)}`;
      }
    }
    
    // Parse the data (dynamic score columns)
    const parsed = parseRankData(content);
    // Extra safety: parse current block from header here too
    const headerBlockMatch = content.match(/MINER RANKING TABLE\s*-\s*Block\s+(\d+)/i);
    const headerBlock = headerBlockMatch ? parseInt(headerBlockMatch[1]) : undefined;
    const { models, scoreOrder } = parsed;
    const currentBlock = parsed.currentBlock ?? (Number.isFinite(headerBlock) ? headerBlock : undefined);
    console.log('====>Parsed models count:', models.length);
    
    if (models.length === 0) {
      console.error('No models parsed! Content sample:', content.substring(0, 500));
    }
    
    // Calculate dominance (threshold-based winner-per-env rule)
    const dominanceMap = calculateDominance(models, scoreOrder);
    console.log('====>Dominance map size:', dominanceMap.size);

    // Fetch coldkey and hotkey for all UIDs
    const uids = models.map(m => m.uid);
    let keysMap: Record<number, { coldkey: string | null; hotkey: string | null }> = {};
    try {
      const keysCommand = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_keys_batch.py ${uids.join(' ')}"`;
      const { stdout } = await execAsync(keysCommand, { timeout: 30000 });
      keysMap = JSON.parse(stdout);
      console.log('====>Fetched keys for', Object.keys(keysMap).length, 'UIDs');
    } catch (error: any) {
      console.error('Failed to fetch keys:', error);
      // Continue without keys - they'll be null
      keysMap = {};
    }

    // Fetch chute_id and model full name for all UIDs
    let commitsMap: Record<number, { chute_id: string | null; model: string | null }> = {};
    try {
      const commitsCommand = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_commit_batch.py ${uids.join(' ')}"`;
      const { stdout } = await execAsync(commitsCommand, { timeout: 30000 });
      commitsMap = JSON.parse(stdout);
      console.log('====>Fetched commits for', Object.keys(commitsMap).length, 'UIDs');
    } catch (error: any) {
      console.error('Failed to fetch commits:', error);
      // Continue without commits - they'll be null
      commitsMap = {};
    }

    // Load model sizes from cache for models that have modelFullName
    const modelSizesMap: Record<number, { modelSizeGB: number | null }> = {};
    try {
      const modelFullNames = Object.values(commitsMap)
        .map(c => c.model)
        .filter((m): m is string => m !== null && m !== undefined);
      
      if (modelFullNames.length > 0) {
        const cachedSizes = await getModelSizesFromCache(modelFullNames);
        
        // Find models missing from cache
        const missingModels = modelFullNames.filter(name => 
          cachedSizes[name] === null || cachedSizes[name] === undefined
        );
        
        // Map cached sizes back to UIDs
        for (const [uid, commits] of Object.entries(commitsMap)) {
          const modelFullName = commits.model;
          if (modelFullName && cachedSizes[modelFullName] !== null && cachedSizes[modelFullName] !== undefined) {
            modelSizesMap[parseInt(uid)] = { modelSizeGB: cachedSizes[modelFullName]! };
          }
        }
        console.log('====>Loaded', Object.keys(modelSizesMap).length, 'model sizes from cache');
        
        // Batch fetch and cache missing model sizes (non-blocking, in background)
        if (missingModels.length > 0) {
          console.log('====>Found', missingModels.length, 'models missing from cache, fetching sizes...');
          // Fetch in batches to avoid overwhelming the system
          const batchSize = 10;
          const cacheUpdates: Record<string, number> = {};
          
          for (let i = 0; i < missingModels.length; i += batchSize) {
            const batch = missingModels.slice(i, i + batchSize);
            try {
              // Fetch by model name (more reliable for caching)
              const modelNamesQuoted = batch.map(m => `"${m}"`).join(' ');
              const command = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_modelsize_batch.py --model ${modelNamesQuoted}"`;
              const { stdout } = await execAsync(command, { timeout: 60000 });
              const result = JSON.parse(stdout);
              
              // Update cache with new sizes
              for (const modelName of batch) {
                const sizeData = result[modelName];
                if (sizeData?.modelSizeGB !== null && sizeData?.modelSizeGB !== undefined) {
                  cacheUpdates[modelName] = sizeData.modelSizeGB;
                  // Also update modelSizesMap for immediate use
                  const uid = Object.entries(commitsMap).find(([_, c]) => c.model === modelName)?.[0];
                  if (uid) {
                    modelSizesMap[parseInt(uid)] = { modelSizeGB: sizeData.modelSizeGB };
                  }
                }
              }
            } catch (error: any) {
              console.error(`Failed to fetch sizes for batch starting at index ${i}:`, error);
              // Continue with next batch
            }
          }
          
          // Batch update cache with all new sizes
          if (Object.keys(cacheUpdates).length > 0) {
            try {
              await setModelSizesInCache(cacheUpdates);
              console.log('====>Updated cache with', Object.keys(cacheUpdates).length, 'new model sizes');
            } catch (cacheError) {
              console.error('Failed to update cache with new sizes:', cacheError);
            }
          }
        }
      }
    } catch (error: any) {
      console.error('Failed to load model sizes from cache:', error);
      // Continue without cached sizes
    }

    const myModelPrefixes = await loadMyPrefixes();
    const teamModelPrefixes = await loadTeamPrefixes();
    console.log('====>Team model prefixes:', teamModelPrefixes);
    // Prepare response
    const response = {
      timestamp: path.basename(usedReportPath, '.txt'),
      scoreOrder,
      currentBlock,
      myModelPrefixes,
      teamModelPrefixes,
      models: models.map(model => {
        const { incompleteProblems, ...modelWithoutSet } = model;
        const keys = keysMap[model.uid] || { coldkey: null, hotkey: null };
        const commits = commitsMap[model.uid] || { chute_id: null, model: null };
        const modelSize = modelSizesMap[model.uid] || { modelSizeGB: null };
        return {
          ...modelWithoutSet,
          incompleteProblems: Array.from(incompleteProblems ?? []),
          dominance: dominanceMap.get(model.uid) || { isDominated: false, dominators: [] },
          coldkey: keys.coldkey,
          hotkey: keys.hotkey,
          chute_id: commits.chute_id,
          modelFullName: commits.model,
          modelSizeGB: modelSize.modelSizeGB
        };
      }),
      cached: !!warning,
      error: warning,
      nextRefreshAvailable: new Date(now + MIN_FETCH_INTERVAL).toISOString()
    };

    // Update cache
    cachedData = response;
    cachedTimestamp = timestamp;
    cachedCurrentBlock = currentBlock;
    lastFetchTime = now;

    return res.status(200).json(response);
  } catch (error: any) {
    console.error('Error fetching rank data:', error);

    // Try fallback from last successful report on any failure.
    const fallback = await loadLatestSuccessfulReport();
    if (fallback) {
      const parsedFallback = parseRankData(fallback.content);
      const headerBlockMatch = fallback.content.match(/MINER RANKING TABLE\s*-\s*Block\s+(\d+)/i);
      const headerBlock = headerBlockMatch ? parseInt(headerBlockMatch[1]) : undefined;
      const { models, scoreOrder } = parsedFallback;
      const currentBlock = parsedFallback.currentBlock ?? (Number.isFinite(headerBlock) ? headerBlock : undefined);
      const dominanceMap = calculateDominance(models, scoreOrder);
      
      // Fetch coldkey and hotkey for all UIDs (fallback case)
      const fallbackUids = models.map(m => m.uid);
      let fallbackKeysMap: Record<number, { coldkey: string | null; hotkey: string | null }> = {};
      try {
        const keysCommand = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_keys_batch.py ${fallbackUids.join(' ')}"`;
        const { stdout } = await execAsync(keysCommand, { timeout: 30000 });
        fallbackKeysMap = JSON.parse(stdout);
      } catch (error: any) {
        console.error('Failed to fetch keys in fallback:', error);
        fallbackKeysMap = {};
      }

      // Fetch chute_id and model full name for all UIDs (fallback case)
      let fallbackCommitsMap: Record<number, { chute_id: string | null; model: string | null }> = {};
      try {
        const commitsCommand = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_commit_batch.py ${fallbackUids.join(' ')}"`;
        const { stdout } = await execAsync(commitsCommand, { timeout: 30000 });
        fallbackCommitsMap = JSON.parse(stdout);
      } catch (error: any) {
        console.error('Failed to fetch commits in fallback:', error);
        fallbackCommitsMap = {};
      }

      // Load model sizes from cache for models that have modelFullName (fallback case)
      const fallbackModelSizesMap: Record<number, { modelSizeGB: number | null }> = {};
      try {
        const fallbackModelFullNames = Object.values(fallbackCommitsMap)
          .map(c => c.model)
          .filter((m): m is string => m !== null && m !== undefined);
        
        if (fallbackModelFullNames.length > 0) {
          const cachedSizes = await getModelSizesFromCache(fallbackModelFullNames);
          
          // Find models missing from cache
          const missingModels = fallbackModelFullNames.filter(name => 
            cachedSizes[name] === null || cachedSizes[name] === undefined
          );
          
          // Map cached sizes back to UIDs
          for (const [uid, commits] of Object.entries(fallbackCommitsMap)) {
            const modelFullName = commits.model;
            if (modelFullName && cachedSizes[modelFullName] !== null && cachedSizes[modelFullName] !== undefined) {
              fallbackModelSizesMap[parseInt(uid)] = { modelSizeGB: cachedSizes[modelFullName]! };
            }
          }
          
          // Batch fetch and cache missing model sizes (non-blocking, in background)
          if (missingModels.length > 0) {
            console.log('====>Found', missingModels.length, 'models missing from cache in fallback, fetching sizes...');
            const batchSize = 10;
            const cacheUpdates: Record<string, number> = {};
            
            for (let i = 0; i < missingModels.length; i += batchSize) {
              const batch = missingModels.slice(i, i + batchSize);
              try {
                const modelNamesQuoted = batch.map(m => `"${m}"`).join(' ');
                const command = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_modelsize_batch.py --model ${modelNamesQuoted}"`;
                const { stdout } = await execAsync(command, { timeout: 60000 });
                const result = JSON.parse(stdout);
                
                for (const modelName of batch) {
                  const sizeData = result[modelName];
                  if (sizeData?.modelSizeGB !== null && sizeData?.modelSizeGB !== undefined) {
                    cacheUpdates[modelName] = sizeData.modelSizeGB;
                    const uid = Object.entries(fallbackCommitsMap).find(([_, c]) => c.model === modelName)?.[0];
                    if (uid) {
                      fallbackModelSizesMap[parseInt(uid)] = { modelSizeGB: sizeData.modelSizeGB };
                    }
                  }
                }
              } catch (error: any) {
                console.error(`Failed to fetch sizes for fallback batch starting at index ${i}:`, error);
              }
            }
            
            if (Object.keys(cacheUpdates).length > 0) {
              try {
                await setModelSizesInCache(cacheUpdates);
                console.log('====>Updated cache with', Object.keys(cacheUpdates).length, 'new model sizes in fallback');
              } catch (cacheError) {
                console.error('Failed to update cache with new sizes in fallback:', cacheError);
              }
            }
          }
        }
      } catch (error: any) {
        console.error('Failed to load model sizes from cache in fallback:', error);
        // Continue without cached sizes
      }
      
      const myModelPrefixes = await loadMyPrefixes();
      const teamModelPrefixes = await loadTeamPrefixes();

      const response = {
        timestamp: path.basename(fallback.reportPath, '.txt'),
        scoreOrder,
        currentBlock,
        myModelPrefixes,
        teamModelPrefixes,
        models: models.map(model => {
          const { incompleteProblems, ...modelWithoutSet } = model;
          const keys = fallbackKeysMap[model.uid] || { coldkey: null, hotkey: null };
          const commits = fallbackCommitsMap[model.uid] || { chute_id: null, model: null };
          const modelSize = fallbackModelSizesMap[model.uid] || { modelSizeGB: null };
          return {
            ...modelWithoutSet,
            incompleteProblems: Array.from(incompleteProblems ?? []),
            dominance: dominanceMap.get(model.uid) || { isDominated: false, dominators: [] },
            coldkey: keys.coldkey,
            hotkey: keys.hotkey,
            chute_id: commits.chute_id,
            modelFullName: commits.model,
            modelSizeGB: modelSize.modelSizeGB
          };
        }),
        cached: true,
        error: `Fetch failed; using last successful report ${path.basename(fallback.reportPath)} (${error?.message ?? 'error'})`,
        nextRefreshAvailable: new Date(now + MIN_FETCH_INTERVAL).toISOString()
      };

      cachedData = response;
      cachedTimestamp = response.timestamp;
      cachedCurrentBlock = currentBlock;
      lastFetchTime = now;
      return res.status(200).json(response);
    }

    // If we have cached data, return it even if there's an error
    if (cachedData) {
      return res.status(200).json({
        ...cachedData,
        cached: true,
        error: error.message,
        timestamp: cachedTimestamp
      });
    }

    return res.status(500).json({
      error: 'Failed to fetch rank data',
      message: error.message
    });
  }
}
