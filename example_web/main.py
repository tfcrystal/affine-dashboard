#!/usr/bin/env python3
"""
FastAPI server for UID dominance status dashboard.
"""

import asyncio
import json
import os
from typing import Dict, List, Optional, Set, Tuple, Any
from collections import defaultdict
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
import uvicorn

from affine.core.miners import miners
from affine.core.setup import NETUID, logger, setup_logging
from affine.utils.subtensor import get_subtensor
from affine.utils.api_client import cli_api_client


app = FastAPI(title="UID Dominance Dashboard")


class UIDStatus(BaseModel):
    uid: int
    hotkey: str
    is_dominated: bool
    dominating_uids: List[int]
    dominated_by_count: int
    dominating_active_count: int  # Number of active miners that dominate this UID
    dominating_non_active_count: int  # Number of non-active miners that dominate this UID
    on_pareto_frontier: bool
    has_data: bool
    is_active: bool  # Whether this UID is active (has at least one valid environment with completeness >= min_completeness)
    age_days: float
    first_block: Optional[int] = None  # First block when miner started (for dominance comparison)
    points: float  # Combinatoric score
    env_scores: Dict[str, float]  # Environment accuracies
    env_confidence_intervals: Dict[str, Tuple[float, float]]  # Environment confidence intervals (lower, upper)
    env_completeness: Dict[str, float]  # Completeness values per environment (0.0 to 1.0)
    env_thresholds: Dict[str, float]  # Threshold values per environment
    env_sample_counts: Dict[str, int]  # Received problem counts per environment (sample_count)
    env_total_problems: Dict[str, int]  # Total problem counts per environment (calculated from sample_count/completeness)
    env_points: Dict[str, float]  # Points per environment (if available)
    model_name: Optional[str] = None  # HuggingFace model name


class DominanceData(BaseModel):
    block: int
    uids: List[UIDStatus]
    total_uids: int
    pareto_frontier_count: int
    dominated_count: int


# Cache for dominance data (keyed by block number)
_cache: Dict[int, DominanceData] = {}
_cache_lock = asyncio.Lock()

# Validator dominance configuration (matching stage2_pareto.py)
ERROR_RATE_REDUCTION = 0.2  # 20% error rate reduction
MIN_IMPROVEMENT = 0.02  # Minimum 2% absolute improvement
MAX_IMPROVEMENT = 0.1  # Maximum 10% improvement cap


def _calculate_required_score(
    prior_score: float,
    error_rate_reduction: float = ERROR_RATE_REDUCTION,
    min_improvement: float = MIN_IMPROVEMENT,
    max_improvement: float = MAX_IMPROVEMENT
) -> float:
    """
    Calculate required score to beat prior (same as validator's calculate_required_score).
    
    The threshold is calculated as: prior_score + improvement_delta
    where improvement_delta is determined by:
    1. Error rate reduction: (1 - prior_score) × error_rate_reduction
    2. Minimum improvement: min_improvement
    3. Maximum improvement cap: max_improvement
    
    Final formula: prior_score + min(max(err_delta, min_improvement), max_improvement)
    
    Args:
        prior_score: Score of the earlier miner (0.0 to 1.0)
        error_rate_reduction: Required error rate reduction ratio (default: 0.2 for 20%)
        min_improvement: Minimum absolute improvement required (default: 0.02)
        max_improvement: Maximum improvement cap (default: 0.1 for 10%)
    
    Returns:
        Required score to dominate the prior miner
    """
    # Calculate error rate reduction delta
    error_delta = (1.0 - prior_score) * error_rate_reduction
    
    # Choose improvement: max of error_delta and min_improvement, capped by max_improvement
    improvement = min(max(error_delta, min_improvement), max_improvement)
    
    # Final threshold, capped at 1.0
    return min(prior_score + improvement, 1.0)


def _check_dominance(
    candidate_hotkey: str,
    target_hotkey: str,
    envs: Tuple[str, ...],
    scores_by_env_map: Dict[str, Dict[str, Dict[str, Any]]],
    stats: Dict[str, Dict[str, Dict[str, Any]]],
    confidence_intervals: Optional[Dict[str, Dict[str, Tuple[float, float]]]] = None
) -> bool:
    """
    Check if candidate miner dominates target miner using validator's threshold-based logic.
    
    This matches the validator's Stage 2 Pareto filtering logic:
    - Miners are compared based on first_block (earlier = higher priority)
    - Later miner must beat earlier miner's threshold in ALL environments
    - Threshold = prior_score + min(max((1-prior)*0.2, 0.02), 0.1)
    
    A dominates B if:
    - A came first (lower first_block) AND B cannot beat A's threshold in ALL environments
    - OR B came first (lower first_block) AND A cannot beat B's threshold in ALL environments
    
    Args:
        candidate_hotkey: Hotkey of candidate miner (A)
        target_hotkey: Hotkey of target miner (B)
        envs: Tuple of environment names
        scores_by_env_map: Map of hotkey -> {env: {score, sample_count, ...}}
        stats: Map of hotkey -> {env: {'samples': int, 'total_score': float, 'first_block': int}}
        confidence_intervals: Optional map of hotkey -> {env: (lower, upper)} CI
    
    Returns:
        True if candidate dominates target, False otherwise
    """
    candidate_scores = scores_by_env_map.get(candidate_hotkey, {})
    target_scores = scores_by_env_map.get(target_hotkey, {})
    
    if not candidate_scores or not target_scores:
        return False
    
    # Get first_block for both miners to determine who came first
    candidate_first_block = None
    target_first_block = None
    
    for env in envs:
        candidate_env_stats = stats.get(candidate_hotkey, {}).get(env, {})
        target_env_stats = stats.get(target_hotkey, {}).get(env, {})
        
        if candidate_first_block is None and candidate_env_stats.get('first_block'):
            candidate_first_block = candidate_env_stats['first_block']
        if target_first_block is None and target_env_stats.get('first_block'):
            target_first_block = target_env_stats['first_block']
    
    # If we can't determine first_block, fall back to simple comparison
    if candidate_first_block is None or target_first_block is None:
        # Fallback: use simple comparison if first_block not available
        candidate_wins = False
        target_wins = False
        
        for env in envs:
            candidate_data = candidate_scores.get(env, {})
            target_data = target_scores.get(env, {})
            
            candidate_score = candidate_data.get("score", 0.0)
            target_score = target_data.get("score", 0.0)
            candidate_samples = candidate_data.get("sample_count", 0)
            target_samples = target_data.get("sample_count", 0)
            
            if candidate_samples == 0 or target_samples == 0:
                continue
            
            if candidate_score > target_score:
                candidate_wins = True
            elif target_score > candidate_score:
                target_wins = True
        
        return candidate_wins and not target_wins
    
    # Determine who came first (earlier first_block = came first)
    if candidate_first_block < target_first_block:
        # Candidate (A) came first - check if target (B) can beat A's threshold
        earlier_hotkey = candidate_hotkey
        later_hotkey = target_hotkey
        earlier_scores = candidate_scores
        later_scores = target_scores
    elif target_first_block < candidate_first_block:
        # Target (B) came first - check if candidate (A) can beat B's threshold
        earlier_hotkey = target_hotkey
        later_hotkey = candidate_hotkey
        earlier_scores = target_scores
        later_scores = candidate_scores
    else:
        # Same first_block - use simple comparison
        candidate_wins = False
        target_wins = False
        
        for env in envs:
            candidate_data = candidate_scores.get(env, {})
            target_data = target_scores.get(env, {})
            
            candidate_score = candidate_data.get("score", 0.0)
            target_score = target_data.get("score", 0.0)
            candidate_samples = candidate_data.get("sample_count", 0)
            target_samples = target_data.get("sample_count", 0)
            
            if candidate_samples == 0 or target_samples == 0:
                continue
            
            if candidate_score > target_score:
                candidate_wins = True
            elif target_score > candidate_score:
                target_wins = True
        
        return candidate_wins and not target_wins
    
    # Apply validator's threshold-based dominance logic
    # Earlier miner wins in an environment if later miner cannot beat threshold
    earlier_wins_count = 0
    later_wins_count = 0
    
    eps = 1e-9  # Epsilon for floating point comparison
    
    for env in envs:
        earlier_data = earlier_scores.get(env, {})
        later_data = later_scores.get(env, {})
        
        earlier_score = earlier_data.get("score", 0.0)
        later_score = later_data.get("score", 0.0)
        earlier_samples = earlier_data.get("sample_count", 0)
        later_samples = later_data.get("sample_count", 0)
        
        # Need both to have samples to compare
        if earlier_samples == 0 or later_samples == 0:
            continue
        
        # Calculate threshold for earlier miner
        threshold = _calculate_required_score(
            earlier_score,
            ERROR_RATE_REDUCTION,
            MIN_IMPROVEMENT,
            MAX_IMPROVEMENT
        )
        
        # Later miner wins if it beats the threshold
        if later_score > (threshold + eps):
            later_wins_count += 1
        else:
            earlier_wins_count += 1
    
    # Count environments where both miners have data
    valid_envs = [
        e for e in envs 
        if earlier_scores.get(e, {}).get("sample_count", 0) > 0 
        and later_scores.get(e, {}).get("sample_count", 0) > 0
    ]
    
    if not valid_envs:
        return False
    
    # Dominance: earlier miner dominates if it wins in ALL environments
    # (i.e., later miner cannot beat threshold in all environments)
    earlier_dominates = (earlier_wins_count == len(valid_envs))
    
    # Return True if candidate dominates target
    if candidate_first_block < target_first_block:
        # Candidate came first (earlier) - candidate dominates if it wins all
        # (i.e., target cannot beat candidate's threshold in all environments)
        return earlier_dominates
    else:
        # Target came first (earlier) - candidate can only dominate if candidate wins all
        # (i.e., candidate beats target's threshold in all environments)
        # In this case, earlier = target, later = candidate
        # So candidate dominates if later_wins_count == len(valid_envs)
        return later_wins_count == len(valid_envs)


def _reconstruct_stats_from_api_scores(
    scores_data: Dict[str, Any],
    meta,
    envs: Tuple[str, ...]
) -> Tuple[Dict[str, Dict[str, Dict[str, Any]]], Dict[str, Dict[str, Tuple[float, float]]], Dict[str, Dict[str, Dict[str, Any]]], Dict[str, Dict[str, float]], Dict[str, Dict[str, float]], Dict[str, Dict[str, int]], Dict[str, Dict[str, int]]]:
    """
    Reconstruct stats and confidence intervals from API scores data.
    
    Args:
        scores_data: Scores data from /scores/latest API endpoint
        meta: Metagraph object
        envs: Tuple of environment names
    
    Returns:
        Tuple of (stats, confidence_intervals, scores_by_env_map, completeness_map, thresholds_map, sample_counts_map, total_problems_map)
        stats: {hotkey: {env: {'samples': int, 'total_score': float, 'first_block': int}}}
        confidence_intervals: {hotkey: {env: (lower, upper)}}
        scores_by_env_map: {hotkey: {env: {score, sample_count, ...}}}
        completeness_map: {hotkey: {env: float}} - Completeness values (0.0 to 1.0)
        thresholds_map: {hotkey: {env: float}} - Threshold values
        sample_counts_map: {hotkey: {env: int}} - Received problem counts (sample_count from API)
        total_problems_map: {hotkey: {env: int}} - Total problem counts (calculated from sample_count/completeness)
    """
    stats = {}
    confidence_intervals = {}
    scores_by_env_map = {}
    completeness_map = {}
    thresholds_map = {}
    sample_counts_map = {}
    total_problems_map = {}
    
    # Initialize for all hotkeys
    for hotkey in meta.hotkeys:
        stats[hotkey] = {}
        confidence_intervals[hotkey] = {}
        scores_by_env_map[hotkey] = {}
        completeness_map[hotkey] = {}
        thresholds_map[hotkey] = {}
        sample_counts_map[hotkey] = {}
        total_problems_map[hotkey] = {}
    
    scores_list = scores_data.get("scores", [])
    
    # Reconstruct from API scores data
    for score in scores_list:
        hotkey = score.get("miner_hotkey")
        if hotkey not in meta.hotkeys:
            continue
        
        first_block = score.get("first_block", 0)
        scores_by_env = score.get("scores_by_env", {})
        total_samples = score.get("total_samples", 0)
        
        # Store scores_by_env for dominance checking
        scores_by_env_map[hotkey] = scores_by_env.copy()
        
        for env in envs:
            if env in scores_by_env:
                env_data = scores_by_env[env]
                env_score = env_data.get("score", 0.0)  # This is accuracy (0-1)
                sample_count = env_data.get("sample_count", 0)
                threshold = env_data.get("threshold", 0.0)
                completeness = env_data.get("completeness", 1.0)
                
                # Calculate total_score from accuracy and sample count
                total_score = env_score * sample_count if sample_count > 0 else 0.0
                
                stats[hotkey][env] = {
                    'samples': sample_count,
                    'total_score': total_score,
                    'first_block': first_block
                }
                
                # Estimate confidence interval from score and threshold
                # Use threshold as lower bound and score as upper bound approximation
                # This is an approximation - ideally we'd have actual CI from API
                if sample_count > 0:
                    # Use threshold as lower bound, score as upper bound
                    # For dominance checking, we need conservative estimates
                    lower = max(0.0, threshold)
                    upper = min(1.0, env_score)
                    confidence_intervals[hotkey][env] = (lower, upper)
                
                # Store completeness and threshold values
                completeness_map[hotkey][env] = completeness
                thresholds_map[hotkey][env] = threshold
                
                # Store sample count (received problems) - this is what was used to calculate completeness
                sample_counts_map[hotkey][env] = sample_count
                
                # Calculate total problems from completeness and sample_count
                # completeness = sample_count / total_problems, so total_problems = sample_count / completeness
                if completeness > 0:
                    total_problems = int(round(sample_count / completeness))
                else:
                    # If completeness is 0, we can't determine total, use 0 or sample_count if sample_count > 0
                    total_problems = sample_count if sample_count > 0 else 0
                total_problems_map[hotkey][env] = total_problems
    
    return stats, confidence_intervals, scores_by_env_map, completeness_map, thresholds_map, sample_counts_map, total_problems_map


async def fetch_environments_from_api(client) -> List[str]:
    """Fetch enabled environments from API (same as get-rank)."""
    try:
        config = await client.get("/config/environments")
        
        if isinstance(config, dict):
            value = config.get("param_value")
            if isinstance(value, dict):
                # Filter environments where enabled_for_scoring=true
                enabled_envs = [
                    env_name for env_name, env_config in value.items()
                    if isinstance(env_config, dict) and env_config.get("enabled_for_scoring", False)
                ]
                
                if enabled_envs:
                    logger.debug(f"Fetched environments from API: {enabled_envs}")
                    return sorted(enabled_envs)
        
        logger.warning("Failed to parse environments config, returning empty list")
        return []
                
    except Exception as e:
        logger.error(f"Error fetching environments: {e}, returning empty list")
        return []


async def get_all_dominance_data(
    block: Optional[int] = None,
    refresh: bool = False
) -> DominanceData:
    """
    Get dominance status for all UIDs.
    
    Uses API client method (same as 'af get-rank') to fetch data from API endpoints.
    Uses caching similar to weights system - if we have cached data for the same block,
    returns cached data instead of recalculating from scratch.
    
    Args:
        block: Optional block number to fetch data for
        refresh: If True, force recalculation even if cached data exists. If False, return cached data if available.
    
    Returns:
        DominanceData with status for all UIDs
    """
    setup_logging(0)  # Minimal logging
    
    # Get metagraph and environment names
    st = await get_subtensor()
    meta = await st.metagraph(NETUID)
    
    # Get current block number
    current_block = meta.block.item() if hasattr(meta.block, 'item') else int(meta.block)
    
    # Determine which block to use for caching
    cache_block = block if block is not None else current_block
    
    # Check cache first - if we have data for this block and not refreshing, return it (no calculation)
    if not refresh:
        async with _cache_lock:
            if cache_block in _cache:
                logger.info(f"Using cached dominance data for block {cache_block} (no calculation needed)")
                return _cache[cache_block]
    else:
        logger.info(f"Refresh requested - forcing complete recalculation of all dominance relationships for block {cache_block}")
        # Clear cache entry for this block to ensure fresh calculation
        async with _cache_lock:
            if cache_block in _cache:
                del _cache[cache_block]
                logger.info(f"Cleared cached data for block {cache_block} to force fresh calculation")
    
    # Use API client to fetch data (same method as 'af get-rank')
    logger.info("Fetching data from API (using same method as 'af get-rank')...")
    
    scores_data = None
    stats = {}
    confidence_intervals = {}
    scores_by_env_map = {}
    completeness_map = {}
    thresholds_map = {}
    scorer_config = {}
    ENVS = tuple()
    
    try:
        async with cli_api_client() as client:
            # Fetch scores, environments, and config (same as get-rank)
            scores_data = await client.get("/scores/latest?top=256")
            
            # Check for API error response
            if isinstance(scores_data, dict) and "success" in scores_data and scores_data.get("success") is False:
                error_msg = scores_data.get("error", "Unknown API error")
                status_code = scores_data.get("status_code", "unknown")
                logger.error(f"API returned error response: {error_msg} (status: {status_code})")
                return DominanceData(
                    block=current_block,
                    uids=[],
                    total_uids=len(meta.hotkeys),
                    pareto_frontier_count=0,
                    dominated_count=0
                )
            
            if not scores_data or not scores_data.get('block_number'):
                logger.error(f"No scores found from API. Response: {scores_data}")
                return DominanceData(
                    block=current_block,
                    uids=[],
                    total_uids=len(meta.hotkeys),
                    pareto_frontier_count=0,
                    dominated_count=0
                )
            
            logger.info(f"Fetched scores data: block={scores_data.get('block_number')}, scores_count={len(scores_data.get('scores', []))}")
            
            environments = await fetch_environments_from_api(client)
            scorer_config = await client.get("/scores/weights/latest")
            
            # Use environments from API, or extract from scores data as fallback
            if environments:
                ENVS = tuple(environments)
            else:
                # Extract environments from scores data as fallback
                scores_list = scores_data.get("scores", [])
                env_set = set()
                for score in scores_list:
                    scores_by_env = score.get("scores_by_env", {})
                    env_set.update(scores_by_env.keys())
                ENVS = tuple(sorted(env_set)) if env_set else tuple()
                if ENVS:
                    logger.info(f"Extracted environments from scores data: {ENVS}")
                else:
                    logger.warning("No environments found in API data")
            
            # Reconstruct stats and confidence intervals from API scores data
            stats, confidence_intervals, scores_by_env_map, completeness_map, thresholds_map, sample_counts_map, total_problems_map = _reconstruct_stats_from_api_scores(scores_data, meta, ENVS)
            
            # Log some debug info
            miners_with_data = sum(1 for hk in meta.hotkeys if any(stats.get(hk, {}).get(e, {}).get('samples', 0) > 0 for e in ENVS))
            logger.info(f"Loaded stats and confidence intervals from API scores data: {miners_with_data} miners with data, {len(ENVS)} environments")
            
    except Exception as e:
        logger.error(f"Failed to fetch data from API: {e}")
        return DominanceData(
            block=current_block,
            uids=[],
            total_uids=len(meta.hotkeys),
            pareto_frontier_count=0,
            dominated_count=0
        )
    
    # If API loading failed, we should not proceed
    # Check if we have actual data (not just empty dicts)
    has_stats_data = any(
        any(env_stats.get('samples', 0) > 0 for env_stats in hk_stats.values())
        for hk_stats in stats.values()
    )
    
    if not scores_data or not has_stats_data:
        logger.error(f"No stats/confidence intervals available from API - cannot proceed. scores_data={bool(scores_data)}, has_stats_data={has_stats_data}")
        return DominanceData(
            block=current_block,
            uids=[],
            total_uids=len(meta.hotkeys),
            pareto_frontier_count=0,
            dominated_count=0
        )
    
    # Ensure we have UIDs for all miners in the metagraph
    if not ENVS:
        logger.error("No environments found - cannot calculate dominance")
        return DominanceData(
            block=current_block,
            uids=[],
            total_uids=len(meta.hotkeys),
            pareto_frontier_count=0,
            dominated_count=0
        )
    
    # Calculate dominance relationships using data from API
    # IMPORTANT: This calculates ALL dominance relationships in ONE ATOMIC OPERATION
    # All pairs are checked, all relationships computed, and all results cached together
    # This ensures consistency - no partial calculations or stale data
    logger.info(f"Computing ALL dominance relationships in one atomic pass for block {cache_block}")
    logger.info(f"Will calculate dominance for all {len(meta.hotkeys)} UIDs against all other UIDs")
    
    # Get model names from commitments
    model_names = {}
    try:
        all_commitments = await st.get_all_revealed_commitments(NETUID)
        for hotkey, commitments_list in all_commitments.items():
            if commitments_list:
                # Get the most recent commitment
                block_number, data = commitments_list[-1]
                try:
                    if isinstance(data, str):
                        commitment_json = json.loads(data)
                    else:
                        commitment_json = data
                    model = commitment_json.get('model', '')
                    revision = commitment_json.get('revision', '')
                    if model:
                        model_name = f"{model}"
                        if revision:
                            model_name += f"@{revision}"
                        model_names[hotkey] = model_name
                except (json.JSONDecodeError, TypeError):
                    pass
    except Exception as e:
        logger.warning(f"Could not fetch commitments: {e}")
    
    # Also extract model names from API scores data
    scores_list = scores_data.get("scores", [])
    for score in scores_list:
        hotkey = score.get("miner_hotkey")
        model = score.get("model", "")
        model_revision = score.get("model_revision", "")
        if model and hotkey not in model_names:
            model_name = model
            if model_revision:
                model_name += f"@{model_revision}"
            model_names[hotkey] = model_name
    
    # Stats and confidence intervals are already loaded from API above
    # No need to reload - we use API data (same as get-rank)
    
    # Calculate age in days (1 block = 12 seconds)
    BLOCK_TIME_SECONDS = 12
    SECONDS_PER_DAY = 60 * 60 * 24
    
    def get_first_block(uid: int) -> Optional[int]:
        """Get first_block for a given UID."""
        if uid >= len(meta.hotkeys):
            return None
        
        hotkey = meta.hotkeys[uid]
        for env_stats in stats.get(hotkey, {}).values():
            if isinstance(env_stats, dict) and 'first_block' in env_stats:
                first_block = env_stats['first_block']
                if first_block and first_block > 0:
                    return first_block
        return None
    
    def calculate_age_days(uid: int) -> float:
        """Calculate age in days for a given UID."""
        if uid >= len(meta.hotkeys):
            return 0.0
        
        first_block = get_first_block(uid)
        if first_block is None or first_block == 0:
            return 0.0
        
        block_diff = current_block - first_block
        age_seconds = block_diff * BLOCK_TIME_SECONDS
        age_days = age_seconds / SECONDS_PER_DAY
        return age_days
    
    # Get min_completeness from config (default: 0.95, matching validator's MIN_COMPLETENESS)
    if not isinstance(scorer_config, dict):
        scorer_config = {}
    min_completeness = scorer_config.get("min_completeness", 0.95)  # Default matches validator's MIN_COMPLETENESS
    
    # Calculate active status using validator's logic:
    # A miner is active if it has at least one environment with completeness >= min_completeness
    active_hks = set()
    scores = {}
    scores_list = scores_data.get("scores", [])
    
    for score in scores_list:
        hotkey = score.get("miner_hotkey")
        overall_score = score.get("overall_score", 0.0)
        scores[hotkey] = overall_score
        
        # Check if miner has at least one valid environment (completeness >= min_completeness)
        # This matches validator's is_valid_for_scoring() logic
        miner_completeness = completeness_map.get(hotkey, {})
        has_valid_env = any(
            completeness >= min_completeness 
            for completeness in miner_completeness.values()
        )
        if has_valid_env:
            active_hks.add(hotkey)
    
    # Calculate accuracies for all miners
    accuracies = {}
    for hk in meta.hotkeys:
        accuracies[hk] = {}
        for e in ENVS:
            env_stats = stats.get(hk, {}).get(e, {'samples': 0, 'total_score': 0.0})
            samples = env_stats.get('samples', 0)
            total_score = env_stats.get('total_score', 0.0)
            if samples > 0:
                accuracies[hk][e] = total_score / samples
            else:
                accuracies[hk][e] = 0.0
    
    # Build dominance graph: for each UID, find what dominates it
    # This calculates ALL dominance relationships in one complete pass
    uid_statuses: List[UIDStatus] = []
    dominance_map: Dict[int, List[int]] = {}  # uid -> list of UIDs that dominate it
    
    logger.info("Building ALL dominance relationships in one atomic calculation...")
    logger.info(f"Total miners to check: {len(meta.hotkeys)}")
    
    # Check dominance for all pairs of active miners
    # This is done in one complete pass - all relationships calculated together
    checked_pairs = 0
    total_pairs_to_check = len(meta.hotkeys) * (len(meta.hotkeys) - 1) // 2
    logger.info(f"Will check up to {total_pairs_to_check} dominance pairs")
    for target_uid, target_hotkey in enumerate(meta.hotkeys):
        if target_uid not in dominance_map:
            dominance_map[target_uid] = []
        
        target_has_data = any(
            stats.get(target_hotkey, {}).get(e, {}).get('samples', 0) > 0 
            for e in ENVS
        )
        
        # Calculate environment scores, confidence intervals, completeness, thresholds, sample counts, total problems, and points
        env_scores_dict = {env: accuracies.get(target_hotkey, {}).get(env, 0.0) for env in ENVS}
        env_ci_dict = {env: confidence_intervals.get(target_hotkey, {}).get(env, (0.0, 0.0)) for env in ENVS}
        env_completeness_dict = {env: completeness_map.get(target_hotkey, {}).get(env, 1.0) for env in ENVS}
        env_thresholds_dict = {env: thresholds_map.get(target_hotkey, {}).get(env, 0.0) for env in ENVS}
        env_sample_counts_dict = {env: sample_counts_map.get(target_hotkey, {}).get(env, 0) for env in ENVS}
        env_total_problems_dict = {env: total_problems_map.get(target_hotkey, {}).get(env, 0) for env in ENVS}
        target_points = scores.get(target_hotkey, 0.0)
        target_model_name = model_names.get(target_hotkey, None)
        
        # Determine if target is active using validator's logic:
        # Active if has at least one environment with completeness >= min_completeness
        target_completeness = completeness_map.get(target_hotkey, {})
        target_is_active = any(
            completeness >= min_completeness 
            for completeness in target_completeness.values()
        )
        
        if not target_has_data:
            # No data, can't be dominated or dominate
            uid_statuses.append(UIDStatus(
                uid=target_uid,
                hotkey=target_hotkey,
                is_dominated=False,
                dominating_uids=[],
                dominated_by_count=0,
                dominating_active_count=0,
                dominating_non_active_count=0,
                on_pareto_frontier=True,  # No data = not in competition
                has_data=False,
                is_active=False,
                age_days=calculate_age_days(target_uid),
                first_block=get_first_block(target_uid),
                points=0.0,
                env_scores=env_scores_dict,
                env_confidence_intervals=env_ci_dict,
                env_completeness=env_completeness_dict,
                env_thresholds=env_thresholds_dict,
                env_sample_counts=env_sample_counts_dict,
                env_total_problems=env_total_problems_dict,
                env_points={},
                model_name=target_model_name
            ))
            continue
        
        # Check if any other miner dominates this target
        # Only count miners that are older than or the same age as the target
        dominating_uids = []
        dominating_active = []
        dominating_non_active = []
        
        # Calculate target miner's age for comparison
        target_age_days = calculate_age_days(target_uid)
        
        for candidate_uid, candidate_hotkey in enumerate(meta.hotkeys):
            if candidate_uid == target_uid:
                continue
            
            candidate_has_data = any(
                stats.get(candidate_hotkey, {}).get(e, {}).get('samples', 0) > 0 
                for e in ENVS
            )
            
            if not candidate_has_data:
                continue
            
            # Skip candidates that are younger than the target
            candidate_age_days = calculate_age_days(candidate_uid)
            if candidate_age_days < target_age_days:
                continue
            
            checked_pairs += 1
            try:
                if _check_dominance(
                    candidate_hotkey,  # miner A
                    target_hotkey,  # miner B (target)
                    ENVS,
                    scores_by_env_map,
                    stats,  # Required for first_block and threshold calculation
                    confidence_intervals
                ):
                    dominating_uids.append(candidate_uid)
                    dominance_map[target_uid].append(candidate_uid)
                    # Check if candidate is active using validator's logic
                    candidate_completeness = completeness_map.get(candidate_hotkey, {})
                    candidate_is_active = any(
                        completeness >= min_completeness 
                        for completeness in candidate_completeness.values()
                    )
                    if candidate_is_active:
                        dominating_active.append(candidate_uid)
                    else:
                        dominating_non_active.append(candidate_uid)
            except Exception as e:
                logger.warning(f"Error checking dominance UID {candidate_uid} vs {target_uid}: {e}")
                continue
        
        is_dominated = len(dominating_uids) > 0
        uid_statuses.append(UIDStatus(
            uid=target_uid,
            hotkey=target_hotkey,
            is_dominated=is_dominated,
            dominating_uids=sorted(dominating_uids),
            dominated_by_count=len(dominating_uids),
            dominating_active_count=len(dominating_active),
            dominating_non_active_count=len(dominating_non_active),
            on_pareto_frontier=not is_dominated,
            has_data=True,
            is_active=target_is_active,
            age_days=calculate_age_days(target_uid),
            first_block=get_first_block(target_uid),
            points=target_points,
            env_scores=env_scores_dict,
            env_confidence_intervals=env_ci_dict,
            env_completeness=env_completeness_dict,
            env_thresholds=env_thresholds_dict,
            env_sample_counts=env_sample_counts_dict,
            env_total_problems=env_total_problems_dict,
            env_points={},  # Can be expanded later if needed
            model_name=target_model_name
        ))
    
    logger.info(f"Completed dominance calculation: checked {checked_pairs} dominance pairs")
    logger.info(f"Created {len(uid_statuses)} UID statuses (expected {len(meta.hotkeys)})")
    
    pareto_count = sum(1 for u in uid_statuses if u.on_pareto_frontier and u.has_data)
    dominated_count = sum(1 for u in uid_statuses if u.is_dominated)
    miners_with_data = sum(1 for u in uid_statuses if u.has_data)
    
    logger.info(f"Dominance calculation complete - Summary: {miners_with_data} miners with data, {pareto_count} on Pareto frontier, {dominated_count} dominated")
    logger.info(f"All dominance relationships calculated in one atomic operation for block {cache_block}")
    
    result = DominanceData(
        block=current_block,
        uids=uid_statuses,
        total_uids=len(meta.hotkeys),
        pareto_frontier_count=pareto_count,
        dominated_count=dominated_count
    )
    
    # Cache the result (use the block that was requested, or current_block)
    # This way subsequent requests for the same block use cached data
    async with _cache_lock:
        _cache[cache_block] = result
        # Keep only last 10 blocks in cache to avoid memory issues
        if len(_cache) > 10:
            oldest_block = min(_cache.keys())
            del _cache[oldest_block]
            logger.info(f"Removed oldest cache entry (block {oldest_block})")
    
    logger.info(f"Cached dominance data for block {cache_block}")
    return result


@app.get("/api/dominance", response_model=DominanceData)
async def get_dominance_data(block: Optional[int] = None, refresh: bool = False):
    """Get dominance status for all UIDs.
    
    Uses API client method (same as 'af get-rank') to fetch data from API endpoints.
    Uses cached data if available for the requested block, avoiding recalculation.
    Only calculates when refresh=True is specified.
    
    Args:
        block: Optional block number to fetch data for
        refresh: If True, force recalculation. If False, return cached data if available.
    """
    try:
        data = await get_all_dominance_data(block=block, refresh=refresh)
        logger.info(f"Returning dominance data: block={data.block}, total_uids={data.total_uids}, uids_count={len(data.uids)}, pareto={data.pareto_frontier_count}, dominated={data.dominated_count}")
        return data
    except Exception as e:
        logger.error(f"Error in get_dominance_data: {e}", exc_info=True)
        # Return empty data structure instead of raising
        return DominanceData(
            block=0,
            uids=[],
            total_uids=0,
            pareto_frontier_count=0,
            dominated_count=0
        )


@app.get("/api/dominance/{uid}")
async def get_uid_dominance(uid: int, block: Optional[int] = None, refresh: bool = False):
    """Get dominance status for a specific UID.
    
    Args:
        uid: The UID to get dominance status for
        block: Optional block number to fetch data for
        refresh: If True, force recalculation. If False, return cached data if available.
    """
    data = await get_all_dominance_data(block=block, refresh=refresh)
    uid_status = next((u for u in data.uids if u.uid == uid), None)
    if uid_status is None:
        return {"error": f"UID {uid} not found"}
    return uid_status


@app.get("/api/dominance/{uid}/dominating")
async def get_dominating_uids_detail(uid: int, block: Optional[int] = None, refresh: bool = False):
    """Get detailed information about all UIDs that dominate a given UID.
    
    Args:
        uid: The UID to get dominating UIDs for
        block: Optional block number to fetch data for
        refresh: If True, force recalculation. If False, return cached data if available.
    """
    data = await get_all_dominance_data(block=block, refresh=refresh)
    uid_status = next((u for u in data.uids if u.uid == uid), None)
    
    if uid_status is None:
        return {"error": f"UID {uid} not found"}
    
    if not uid_status.dominating_uids:
        return {"uid": uid, "dominating_uids": []}
    
    # Get full details for each dominating UID
    dominating_details = []
    missing_uids = []
    for dom_uid in uid_status.dominating_uids:
        dom_status = next((u for u in data.uids if u.uid == dom_uid), None)
        if dom_status:
            dominating_details.append(dom_status.dict())
        else:
            missing_uids.append(dom_uid)
            logger.warning(f"UID {uid}: Dominating UID {dom_uid} not found in data.uids (total uids: {len(data.uids)})")
    
    # Log if we're missing some dominating UIDs
    if missing_uids:
        logger.warning(f"UID {uid}: Found {len(dominating_details)}/{len(uid_status.dominating_uids)} dominating UIDs. Missing: {missing_uids}")
    else:
        logger.info(f"UID {uid}: Successfully found all {len(dominating_details)} dominating UIDs")
    
    return {
        "uid": uid,
        "dominating_uids": dominating_details,
        "total_count": len(dominating_details),
        "expected_count": len(uid_status.dominating_uids),
        "active_count": uid_status.dominating_active_count,
        "non_active_count": uid_status.dominating_non_active_count
    }


@app.post("/api/dominance/refresh")
async def refresh_dominance_data(block: Optional[int] = None):
    """Force refresh of dominance data by recalculating from API.
    
    This endpoint forces a recalculation of dominance data, bypassing the cache.
    Use this when you want to update the dominance calculations with the latest data.
    
    Args:
        block: Optional block number to fetch data for. If not provided, uses current block.
    
    Returns:
        DominanceData with refreshed status for all UIDs
    """
    try:
        data = await get_all_dominance_data(block=block, refresh=True)
        logger.info(f"Refreshed dominance data: block={data.block}, total_uids={data.total_uids}, uids_count={len(data.uids)}, pareto={data.pareto_frontier_count}, dominated={data.dominated_count}")
        return {"success": True, "message": f"Dominance data refreshed for block {data.block}", "data": data}
    except Exception as e:
        logger.error(f"Error refreshing dominance data: {e}", exc_info=True)
        return {"success": False, "error": str(e)}


@app.post("/api/dominance/refresh-all")
async def refresh_all_dominance_data(block: Optional[int] = None):
    """Force refresh of ALL dominance data including all detail relationships in one call.
    
    This endpoint calculates main dominance data AND pre-calculates all dominance detail
    relationships for all UIDs in a single operation. This is more efficient than making
    multiple API calls.
    
    Args:
        block: Optional block number to fetch data for. If not provided, uses current block.
    
    Returns:
        Dict with main data and all dominance detail data:
        {
            "main_data": DominanceData,
            "detail_data": {
                uid: {
                    "uid": int,
                    "dominating_uids": [...],
                    "total_count": int,
                    "active_count": int,
                    "non_active_count": int
                }
            }
        }
    """
    try:
        # Step 1: Calculate main dominance data
        main_data = await get_all_dominance_data(block=block, refresh=True)
        logger.info(f"Calculated main dominance data: block={main_data.block}, total_uids={main_data.total_uids}")
        
        # Step 2: Pre-calculate all dominance detail data for dominated UIDs
        detail_data = {}
        dominated_uids = [u for u in main_data.uids if u.dominating_uids and len(u.dominating_uids) > 0]
        
        logger.info(f"Pre-calculating detail data for {len(dominated_uids)} dominated UIDs...")
        for uid_status in dominated_uids:
            uid = uid_status.uid
            dominating_details = []
            missing_uids = []
            
            for dom_uid in uid_status.dominating_uids:
                dom_status = next((u for u in main_data.uids if u.uid == dom_uid), None)
                if dom_status:
                    dominating_details.append(dom_status.dict())
                else:
                    missing_uids.append(dom_uid)
            
            if missing_uids:
                logger.warning(f"UID {uid}: Found {len(dominating_details)}/{len(uid_status.dominating_uids)} dominating UIDs. Missing: {missing_uids}")
            
            detail_data[uid] = {
                "uid": uid,
                "dominating_uids": dominating_details,
                "total_count": len(dominating_details),
                "expected_count": len(uid_status.dominating_uids),
                "active_count": uid_status.dominating_active_count,
                "non_active_count": uid_status.dominating_non_active_count
            }
        
        logger.info(f"Pre-calculated detail data for {len(detail_data)} UIDs")
        
        return {
            "success": True,
            "message": f"All dominance data calculated for block {main_data.block}",
            "main_data": main_data.dict(),
            "detail_data": detail_data
        }
    except Exception as e:
        logger.error(f"Error calculating all dominance data: {e}", exc_info=True)
        return {"success": False, "error": str(e)}
    """Force refresh of ALL dominance data including all detail relationships in one call.
    
    This endpoint calculates main dominance data AND pre-calculates all dominance detail
    relationships for all UIDs in a single operation. This is more efficient than making
    multiple API calls.
    
    Args:
        block: Optional block number to fetch data for. If not provided, uses current block.
    
    Returns:
        Dict with main data and all dominance detail data:
        {
            "main_data": DominanceData,
            "detail_data": {
                uid: {
                    "uid": int,
                    "dominating_uids": [...],
                    "total_count": int,
                    "active_count": int,
                    "non_active_count": int
                }
            }
        }
    """
    try:
        # Step 1: Calculate main dominance data
        main_data = await get_all_dominance_data(block=block, refresh=True)
        logger.info(f"Calculated main dominance data: block={main_data.block}, total_uids={main_data.total_uids}")
        
        # Step 2: Pre-calculate all dominance detail data for dominated UIDs
        detail_data = {}
        dominated_uids = [u for u in main_data.uids if u.dominating_uids and len(u.dominating_uids) > 0]
        
        logger.info(f"Pre-calculating detail data for {len(dominated_uids)} dominated UIDs...")
        for uid_status in dominated_uids:
            uid = uid_status.uid
            dominating_details = []
            missing_uids = []
            
            for dom_uid in uid_status.dominating_uids:
                dom_status = next((u for u in main_data.uids if u.uid == dom_uid), None)
                if dom_status:
                    dominating_details.append(dom_status.dict())
                else:
                    missing_uids.append(dom_uid)
            
            if missing_uids:
                logger.warning(f"UID {uid}: Found {len(dominating_details)}/{len(uid_status.dominating_uids)} dominating UIDs. Missing: {missing_uids}")
            
            detail_data[uid] = {
                "uid": uid,
                "dominating_uids": dominating_details,
                "total_count": len(dominating_details),
                "expected_count": len(uid_status.dominating_uids),
                "active_count": uid_status.dominating_active_count,
                "non_active_count": uid_status.dominating_non_active_count
            }
        
        logger.info(f"Pre-calculated detail data for {len(detail_data)} UIDs")
        
        return {
            "success": True,
            "message": f"All dominance data calculated for block {main_data.block}",
            "main_data": main_data.dict(),
            "detail_data": detail_data
        }
    except Exception as e:
        logger.error(f"Error calculating all dominance data: {e}", exc_info=True)
        return {"success": False, "error": str(e)}


@app.get("/", response_class=HTMLResponse)
async def read_root():
    """Serve the dashboard HTML."""
    html_path = os.path.join(os.path.dirname(__file__), "dashboard.html")
    with open(html_path, "r") as f:
        return HTMLResponse(content=f.read())


@app.get("/uid/{uid}", response_class=HTMLResponse)
async def read_uid_page(uid: int):
    """Serve the UID detail page."""
    html_path = os.path.join(os.path.dirname(__file__), "dashboard.html")
    with open(html_path, "r") as f:
        content = f.read()
        # Inject UID into the page for detail view
        content = content.replace('<title>UID Dominance Dashboard</title>', 
                                 f'<title>UID {uid} - Dominance Details</title>')
        content = content.replace('let currentData = null;', 
                                 f'let currentData = null; let detailUid = {uid};')
        return HTMLResponse(content=content)


# Mount static files if needed
# app.mount("/static", StaticFiles(directory="static"), name="static")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=1999)

