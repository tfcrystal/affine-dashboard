"""
Utility script to get coldkey and hotkey for multiple UIDs in batch.
Outputs JSON with uid -> {coldkey, hotkey} mapping.

Usage:
python get_keys_batch.py 1 2 3 4 5
"""

import asyncio
import json
import sys
from affine.core.setup import NETUID, logger
from affine.utils.subtensor import get_subtensor


async def get_keys_for_uids(uids: list[int], netuid: int = NETUID) -> dict:
    """Get coldkey and hotkey for multiple UIDs.
    
    Args:
        uids: List of UIDs to query
        netuid: Network UID (default: from config)
        
    Returns:
        Dict mapping uid -> {coldkey, hotkey} or {coldkey: None, hotkey: None} if not found
    """
    try:
        subtensor = await get_subtensor()
        meta = await subtensor.metagraph(netuid)
        
        result = {}
        for uid in uids:
            if uid >= len(meta.hotkeys):
                result[uid] = {"coldkey": None, "hotkey": None}
                continue
            
            hotkey = meta.hotkeys[uid]
            coldkey = meta.coldkeys[uid] if uid < len(meta.coldkeys) else None
            
            result[uid] = {
                "coldkey": coldkey,
                "hotkey": hotkey
            }
        
        return result
    except Exception as e:
        logger.error(f"Failed to get keys for UIDs: {e}")
        return {uid: {"coldkey": None, "hotkey": None} for uid in uids}


async def main():
    """CLI interface for batch key lookup."""
    if len(sys.argv) < 2:
        print(json.dumps({}))
        sys.exit(0)
    
    try:
        uids = [int(arg) for arg in sys.argv[1:]]
        result = await get_keys_for_uids(uids)
        print(json.dumps(result, indent=2))
    except ValueError as e:
        logger.error(f"Invalid UID: {e}")
        print(json.dumps({}))
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())