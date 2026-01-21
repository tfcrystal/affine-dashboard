"""
Utility script to get model size in GB for multiple UIDs or model names in batch.
Outputs JSON with uid/model_name -> {modelSizeGB} mapping.

Usage:
  # With UIDs:
  python get_modelsize_batch.py 1 2 3 4 5
  
  # With model names (use --model flag):
  python get_modelsize_batch.py --model "user/model1" "user/model2"
"""

import asyncio
import json
import sys
import os

# Add parent directory to path so we can import affine module
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from affine.core.setup import NETUID, logger
from affine.utils.subtensor import get_subtensor

# Add the functions directory to path to import scraping function
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'functions'))
from get_modelsize_scraping import get_model_total_size_gb


async def get_model_sizes_for_uids(uids: list[int], netuid: int = NETUID) -> dict:
    """Get model size in GB for multiple UIDs.
    
    Args:
        uids: List of UIDs to query
        netuid: Network UID (default: from config)
        
    Returns:
        Dict mapping uid -> {modelSizeGB: float | None}
    """
    try:
        subtensor = await get_subtensor()
        meta = await subtensor.metagraph(netuid)
        commits = await subtensor.get_all_revealed_commitments(netuid)
        
        result = {}
        for uid in uids:
            if uid >= len(meta.hotkeys):
                result[uid] = {"modelSizeGB": None}
                continue
            
            hotkey = meta.hotkeys[uid]
            
            if hotkey not in commits:
                result[uid] = {"modelSizeGB": None}
                continue
            
            try:
                block, commit_data = commits[hotkey][-1]
                data = json.loads(commit_data) if isinstance(commit_data, str) else commit_data
                model_full_name = data.get("model")
                if not model_full_name:
                    logger.debug(f"No model name found for uid={uid}")
                    result[uid] = {"modelSizeGB": None}
                    continue
                
                # Scrape model size from Hugging Face
                logger.debug(f"Fetching size for uid={uid}, model={model_full_name}")
                size_gb = get_model_total_size_gb(model_full_name)
                if size_gb is None:
                    logger.debug(f"Failed to get size for uid={uid}, model={model_full_name}")
                else:
                    logger.debug(f"Successfully got size {size_gb} GB for uid={uid}, model={model_full_name}")
                result[uid] = {"modelSizeGB": size_gb}
                
            except (json.JSONDecodeError, KeyError) as e:
                logger.debug(f"Failed to parse commit for uid={uid}: {e}")
                result[uid] = {"modelSizeGB": None}
            except Exception as e:
                logger.debug(f"Failed to get model size for uid={uid}: {e}", exc_info=True)
                result[uid] = {"modelSizeGB": None}
        
        return result
    except Exception as e:
        logger.error(f"Failed to get model sizes for UIDs: {e}")
        return {uid: {"modelSizeGB": None} for uid in uids}


async def get_model_sizes_for_names(model_names: list[str]) -> dict:
    """Get model size in GB for multiple model names.
    
    Args:
        model_names: List of model names (e.g., ["user/model1", "user/model2"])
        
    Returns:
        Dict mapping model_name -> {modelSizeGB: float | None}
    """
    result = {}
    for model_name in model_names:
        if not model_name or not isinstance(model_name, str):
            result[model_name] = {"modelSizeGB": None}
            continue
        
        try:
            logger.debug(f"Fetching size for model={model_name}")
            size_gb = get_model_total_size_gb(model_name)
            if size_gb is None:
                logger.debug(f"Failed to get size for model={model_name}")
            else:
                logger.debug(f"Successfully got size {size_gb} GB for model={model_name}")
            result[model_name] = {"modelSizeGB": size_gb}
        except Exception as e:
            logger.debug(f"Failed to get model size for model={model_name}: {e}", exc_info=True)
            result[model_name] = {"modelSizeGB": None}
    
    return result


async def main():
    """CLI interface for batch model size lookup."""
    if len(sys.argv) < 2:
        print(json.dumps({}))
        sys.exit(0)
    
    try:
        # Check if --model flag is used for direct model name input
        if sys.argv[1] == "--model" or sys.argv[1] == "-m":
            if len(sys.argv) < 3:
                print(json.dumps({}))
                sys.exit(0)
            model_names = sys.argv[2:]
            result = await get_model_sizes_for_names(model_names)
        else:
            # Default: treat arguments as UIDs
            uids = [int(arg) for arg in sys.argv[1:]]
            result = await get_model_sizes_for_uids(uids)
        
        # Output only JSON to stdout - no print statements before this
        print(json.dumps(result, indent=2))
    except ValueError as e:
        logger.error(f"Invalid input: {e}")
        print(json.dumps({}))
        sys.exit(1)
    except Exception as e:
        logger.error(f"Unexpected error in main: {e}")
        # Still output valid JSON on error
        print(json.dumps({}))
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

