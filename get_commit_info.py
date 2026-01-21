"""
Utility script to get commit information from various identifiers:
- UID
- Hugging Face model name
- Coldkey
- Hotkey

# Query by UID
python get_commit_info.py uid 7

# Query by model name
python get_commit_info.py model tfc101728/affine-tbtf2
python get_commit_info.py model tfc101728/affine-tbtf2@93a53a0f596eade9da78af583b6c10dba70308ee

# Query by coldkey
python get_commit_info.py coldkey 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY

# Query by hotkey
python get_commit_info.py hotkey 5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty

"""

import asyncio
import json
import sys
import os
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, List, Tuple

# Add parent directory to path so we can import affine module
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from affine.core.setup import NETUID, logger
from affine.utils.subtensor import get_subtensor

# Bittensor block time is approximately 12 seconds
BLOCK_TIME_SECONDS = 12


async def get_block_timestamp(block: int) -> datetime:
    """Convert block number to datetime in UTC+9.
    
    Args:
        block: Block number
        
    Returns:
        Datetime object in UTC+9 timezone
    """
    try:
        # Get current block to calculate timestamp more accurately
        subtensor = await get_subtensor()
        current_block = await subtensor.get_current_block()
        current_time = datetime.now(timezone.utc)
        
        # Calculate block difference
        block_diff = current_block - block
        
        # Calculate timestamp: current time minus (block_diff * block_time)
        timestamp_utc = (current_time.timestamp() - (block_diff * BLOCK_TIME_SECONDS))
        dt_utc = datetime.fromtimestamp(timestamp_utc, tz=timezone.utc)
    except Exception:
        # Fallback: use approximate calculation with known genesis
        # Bittensor Finney genesis was around block 0, timestamp ~2021-01-01
        GENESIS_BLOCK = 0
        GENESIS_TIMESTAMP = datetime(2021, 1, 1, 0, 0, 0, tzinfo=timezone.utc).timestamp()
        timestamp_utc = GENESIS_TIMESTAMP + (block - GENESIS_BLOCK) * BLOCK_TIME_SECONDS
        dt_utc = datetime.fromtimestamp(timestamp_utc, tz=timezone.utc)
    
    # Convert to UTC+9 (Asia/Tokyo)
    utc_plus_9 = timezone(timedelta(hours=9))
    dt_utc9 = dt_utc.astimezone(utc_plus_9)
    
    return dt_utc9


def format_datetime_utc9(dt: datetime) -> str:
    """Format datetime in UTC+9 with readable timezone format.
    
    Args:
        dt: Datetime object in UTC+9
        
    Returns:
        Formatted string like "2024-01-01 12:00:00 +09:00"
    """
    formatted = dt.strftime("%Y-%m-%d %H:%M:%S %z")
    # Add colon to timezone offset (e.g., "+0900" -> "+09:00")
    if len(formatted) >= 6 and formatted[-5] in ['+', '-']:
        formatted = formatted[:-2] + ':' + formatted[-2:]
    return formatted


async def get_commit_from_uid(uid: int, netuid: int = NETUID) -> Optional[Dict]:
    """Get commit info from UID.
    
    Args:
        uid: Miner UID
        netuid: Network UID (default: from config)
        
    Returns:
        Dict with commit info or None if not found
    """
    try:
        subtensor = await get_subtensor()
        meta = await subtensor.metagraph(netuid)
        commits = await subtensor.get_all_revealed_commitments(netuid)
        
        if uid >= len(meta.hotkeys):
            logger.error(f"Invalid UID {uid}")
            return None
        
        hotkey = meta.hotkeys[uid]
        
        if hotkey not in commits:
            logger.warning(f"No commit found for UID {uid}")
            return None
        
        block, commit_data = commits[hotkey][-1]
        data = json.loads(commit_data) if isinstance(commit_data, str) else commit_data
        
        block_num = int(block) if uid != 0 else 0
        commit_time = await get_block_timestamp(block_num)
        
        return {
            "uid": uid,
            "hotkey": hotkey,
            "coldkey": meta.coldkeys[uid] if uid < len(meta.coldkeys) else None,
            "block": block_num,
            "commit_time": format_datetime_utc9(commit_time),
            "model": data.get("model"),
            "revision": data.get("revision"),
            "chute_id": data.get("chute_id"),
            "commit_data": data
        }
    except Exception as e:
        logger.error(f"Failed to get commit from UID {uid}: {e}")
        return None


async def get_commits_from_model(model_name: str, netuid: int = NETUID) -> List[Dict]:
    """Get all commits for a Hugging Face model.
    
    Args:
        model_name: Hugging Face model name (e.g., "username/repo" or "username/repo@revision")
        netuid: Network UID (default: from config)
        
    Returns:
        List of dicts with commit info for all miners using this model
    """
    try:
        subtensor = await get_subtensor()
        meta = await subtensor.metagraph(netuid)
        commits = await subtensor.get_all_revealed_commitments(netuid)
        
        # Parse model name (handle optional revision)
        model_repo = model_name.split("@")[0] if "@" in model_name else model_name
        model_revision = model_name.split("@")[1] if "@" in model_name else None
        
        results = []
        
        for uid, hotkey in enumerate(meta.hotkeys):
            if hotkey not in commits:
                continue
            
            try:
                block, commit_data = commits[hotkey][-1]
                data = json.loads(commit_data) if isinstance(commit_data, str) else commit_data
                
                commit_model = data.get("model", "")
                commit_revision = data.get("revision", "")
                
                # Match model repo
                if commit_model != model_repo:
                    continue
                
                # If revision specified, match it too
                if model_revision and commit_revision != model_revision:
                    continue
                
                block_num = int(block) if uid != 0 else 0
                commit_time = await get_block_timestamp(block_num)
                
                results.append({
                    "uid": uid,
                    "hotkey": hotkey,
                    "coldkey": meta.coldkeys[uid] if uid < len(meta.coldkeys) else None,
                    "block": block_num,
                    "commit_time": format_datetime_utc9(commit_time),
                    "model": commit_model,
                    "revision": commit_revision,
                    "chute_id": data.get("chute_id"),
                    "commit_data": data
                })
            except (json.JSONDecodeError, KeyError) as e:
                logger.debug(f"Failed to parse commit for uid={uid}: {e}")
                continue
        
        return results
    except Exception as e:
        logger.error(f"Failed to get commits from model {model_name}: {e}")
        return []


async def get_commits_from_coldkey(coldkey: str, netuid: int = NETUID) -> List[Dict]:
    """Get all commits for a coldkey (wallet).
    
    Args:
        coldkey: Coldkey address (SS58 format)
        netuid: Network UID (default: from config)
        
    Returns:
        List of dicts with commit info for all hotkeys under this coldkey
    """
    try:
        subtensor = await get_subtensor()
        meta = await subtensor.metagraph(netuid)
        commits = await subtensor.get_all_revealed_commitments(netuid)
        
        results = []
        
        for uid, coldkey_addr in enumerate(meta.coldkeys):
            if coldkey_addr != coldkey:
                continue
            
            hotkey = meta.hotkeys[uid]
            
            if hotkey not in commits:
                continue
            
            try:
                block, commit_data = commits[hotkey][-1]
                data = json.loads(commit_data) if isinstance(commit_data, str) else commit_data
                
                block_num = int(block) if uid != 0 else 0
                commit_time = await get_block_timestamp(block_num)
                
                results.append({
                    "uid": uid,
                    "hotkey": hotkey,
                    "coldkey": coldkey_addr,
                    "block": block_num,
                    "commit_time": format_datetime_utc9(commit_time),
                    "model": data.get("model"),
                    "revision": data.get("revision"),
                    "chute_id": data.get("chute_id"),
                    "commit_data": data
                })
            except (json.JSONDecodeError, KeyError) as e:
                logger.debug(f"Failed to parse commit for uid={uid}: {e}")
                continue
        
        return results
    except Exception as e:
        logger.error(f"Failed to get commits from coldkey {coldkey}: {e}")
        return []


async def get_commit_from_hotkey(hotkey: str, netuid: int = NETUID) -> Optional[Dict]:
    """Get commit info from hotkey.
    
    Args:
        hotkey: Hotkey address (SS58 format)
        netuid: Network UID (default: from config)
        
    Returns:
        Dict with commit info or None if not found
    """
    try:
        subtensor = await get_subtensor()
        meta = await subtensor.metagraph(netuid)
        commits = await subtensor.get_all_revealed_commitments(netuid)
        
        if hotkey not in commits:
            logger.warning(f"No commit found for hotkey {hotkey}")
            return None
        
        # Find UID for this hotkey
        uid = None
        for i, hk in enumerate(meta.hotkeys):
            if hk == hotkey:
                uid = i
                break
        
        if uid is None:
            logger.warning(f"Hotkey {hotkey} not found in metagraph")
            return None
        
        block, commit_data = commits[hotkey][-1]
        data = json.loads(commit_data) if isinstance(commit_data, str) else commit_data
        
        block_num = int(block) if uid != 0 else 0
        commit_time = await get_block_timestamp(block_num)
        
        return {
            "uid": uid,
            "hotkey": hotkey,
            "coldkey": meta.coldkeys[uid] if uid < len(meta.coldkeys) else None,
            "block": block_num,
            "commit_time": format_datetime_utc9(commit_time),
            "model": data.get("model"),
            "revision": data.get("revision"),
            "chute_id": data.get("chute_id"),
            "commit_data": data
        }
    except Exception as e:
        logger.error(f"Failed to get commit from hotkey {hotkey}: {e}")
        return None


async def main():
    """CLI interface for querying commit info."""
    if len(sys.argv) < 3:
        print("Usage:")
        print("  python get_commit_info.py uid <uid>")
        print("  python get_commit_info.py model <model_name> [@revision]")
        print("  python get_commit_info.py coldkey <coldkey_address>")
        print("  python get_commit_info.py hotkey <hotkey_address>")
        sys.exit(1)
    
    query_type = sys.argv[1].lower()
    query_value = sys.argv[2]
    
    result = None
    
    if query_type == "uid":
        uid = int(query_value)
        result = await get_commit_from_uid(uid)
        if result:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(f"No commit found for UID {uid}")
    
    elif query_type == "model":
        results = await get_commits_from_model(query_value)
        if results:
            print(json.dumps(results, indent=2, ensure_ascii=False))
        else:
            print(f"No commits found for model {query_value}")
    
    elif query_type == "coldkey":
        results = await get_commits_from_coldkey(query_value)
        if results:
            print(json.dumps(results, indent=2, ensure_ascii=False))
        else:
            print(f"No commits found for coldkey {query_value}")
    
    elif query_type == "hotkey":
        result = await get_commit_from_hotkey(query_value)
        if result:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(f"No commit found for hotkey {query_value}")
    
    else:
        print(f"Unknown query type: {query_type}")
        print("Supported types: uid, model, coldkey, hotkey")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

