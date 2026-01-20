"""
Utility script to get chute_id and model full name for multiple UIDs in batch.
Outputs JSON with uid -> {chute_id, model} mapping.

Usage:
python get_commit_batch.py 1 2 3 4 5
"""

import asyncio
import json
import sys
from affine.core.setup import NETUID, logger
from affine.utils.subtensor import get_subtensor


async def get_commits_for_uids(uids: list[int], netuid: int = NETUID) -> dict:
    """Get chute_id and model full name for multiple UIDs.
    
    Args:
        uids: List of UIDs to query
        netuid: Network UID (default: from config)
        
    Returns:
        Dict mapping uid -> {chute_id, model} or {chute_id: None, model: None} if not found
    """
    try:
        subtensor = await get_subtensor()
        meta = await subtensor.metagraph(netuid)
        commits = await subtensor.get_all_revealed_commitments(netuid)
        
        result = {}
        for uid in uids:
            if uid >= len(meta.hotkeys):
                result[uid] = {"chute_id": None, "model": None}
                continue
            
            hotkey = meta.hotkeys[uid]
            
            if hotkey not in commits:
                result[uid] = {"chute_id": None, "model": None}
                continue
            
            try:
                block, commit_data = commits[hotkey][-1]
                data = json.loads(commit_data) if isinstance(commit_data, str) else commit_data
                
                result[uid] = {
                    "chute_id": data.get("chute_id"),
                    "model": data.get("model")
                }
            except (json.JSONDecodeError, KeyError) as e:
                logger.debug(f"Failed to parse commit for uid={uid}: {e}")
                result[uid] = {"chute_id": None, "model": None}
        
        return result
    except Exception as e:
        logger.error(f"Failed to get commits for UIDs: {e}")
        return {uid: {"chute_id": None, "model": None} for uid in uids}


async def main():
    """CLI interface for batch commit lookup."""
    if len(sys.argv) < 2:
        print(json.dumps({}))
        sys.exit(0)
    
    try:
        uids = [int(arg) for arg in sys.argv[1:]]
        result = await get_commits_for_uids(uids)
        print(json.dumps(result, indent=2))
    except ValueError as e:
        logger.error(f"Invalid UID: {e}")
        print(json.dumps({}))
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

