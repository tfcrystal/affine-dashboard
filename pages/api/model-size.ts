import { NextApiRequest, NextApiResponse } from 'next';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getModelSizeFromCache, setModelSizeInCache } from '../../utils/modelSizeCache';

const execAsync = promisify(exec);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uid, model } = req.query;

  if (!uid && !model) {
    return res.status(400).json({ error: 'Either uid or model parameter is required' });
  }

  try {
    let modelFullName: string | null = null;
    let modelSize: number | null = null;

    // If model name is provided, check cache first
    if (model) {
      modelFullName = (Array.isArray(model) ? model[0] : model) ?? null;
      if (modelFullName) {
        const cachedSize = await getModelSizeFromCache(modelFullName);
        if (cachedSize !== null) {
          return res.status(200).json({ modelSizeGB: cachedSize });
        }
      }
    }

    // If fetching by UID, first get the modelFullName from commits so we can cache it
    if (uid && !modelFullName) {
      try {
        const uidValue = Array.isArray(uid) ? uid[0] : uid;
        const commitsCommand = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_commit_batch.py ${uidValue}"`;
        const { stdout: commitsStdout } = await execAsync(commitsCommand, { timeout: 15000 });
        const commitsResult = JSON.parse(commitsStdout);
        const commitData = commitsResult[uidValue];
        if (commitData?.model) {
          modelFullName = commitData.model;
          // Check cache again now that we have the model name
          if (modelFullName) {
            const cachedSize = await getModelSizeFromCache(modelFullName);
            if (cachedSize !== null) {
              return res.status(200).json({ modelSizeGB: cachedSize });
            }
          }
        }
      } catch (error: any) {
        console.error(`Failed to get model name for uid=${uid}:`, error);
        // Continue to fetch by UID anyway
      }
    }

    // If not in cache or uid provided, fetch from Python script
    let command: string;
    if (uid) {
      // Fetch by UID
      const uidValue = Array.isArray(uid) ? uid[0] : uid;
      command = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_modelsize_batch.py ${uidValue}"`;
    } else {
      // Fetch by model name
      const modelName = Array.isArray(model) ? model[0] : model;
      modelFullName = modelName ?? null;
      command = `bash -c "cd /root/bittensor/affine-cortex/product-web && source .venv/bin/activate && python get_modelsize_batch.py --model \\"${modelName}\\""`;
    }

    const { stdout } = await execAsync(command, { timeout: 30000 });
    const result = JSON.parse(stdout);
    
    // Return the first (and only) result
    const firstKey = Object.keys(result)[0];
    const resultData = result[firstKey];
    modelSize = resultData?.modelSizeGB ?? null;
    
    // If we got a valid model size and modelFullName, update cache
    // Cache by modelFullName (not UID) since UID can change over time
    if (modelSize !== null && modelSize !== undefined && modelFullName) {
      try {
        await setModelSizeInCache(modelFullName, modelSize);
      } catch (cacheError) {
        console.error('Failed to update model size cache:', cacheError);
        // Continue even if cache update fails
      }
    }
    
    return res.status(200).json({ modelSizeGB: modelSize });
  } catch (error: any) {
    console.error(`Failed to fetch model size for ${uid ? `uid=${uid}` : `model=${model}`}:`, error);
    return res.status(200).json({ modelSizeGB: null }); // Return null instead of error to allow UI to continue
  }
}

