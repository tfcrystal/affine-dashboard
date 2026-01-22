import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import { ClipboardIcon, EyeIcon, EyeSlashIcon, SunIcon, MoonIcon } from '@heroicons/react/24/outline';
import { useTheme } from '../utils/theme';

interface ModelData {
  uid: number;
  modelName: string;
  firstBlk: number;
  scores: Record<string, number>;
  epsilonThresholds: Record<string, number>;
  incompleteProblems?: string[];
  sampleCounts?: Record<string, number>;
  points: number;
  weight: number;
  eligible: string;
  coldkey?: string | null;
  hotkey?: string | null;
  chute_id?: string | null;
  modelFullName?: string | null;
  modelSizeGB?: number | null;
  rank?: number;
  dominance: {
    isDominated: boolean;
    dominators: Array<{
      uid: number;
      modelName: string;
      margins: Record<string, number>;
      scores?: Record<string, number>;
      epsilonThresholds?: Record<string, number>;
      sampleCounts?: Record<string, number>;
      incompleteProblems?: string[];
    }>;
  };
}

interface RankData {
  timestamp: string;
  scoreOrder?: string[];
  currentBlock?: number;
  myModelPrefixes?: string[];
  teamModelPrefixes?: string[];
  models: ModelData[];
  cached: boolean;
  nextRefreshAvailable?: string;
  error?: string;
}

// Utility function to truncate model full name to at most 36 chars, add "..." if too long
function truncateModelFullName(name: string, cutLength: number = 36) {
  if (name.length <= cutLength) return name;
  // Remove cutLength characters from the end, then add "..."
  return name.slice(0, name.length - cutLength) + '...';
}

// The tooltip logic needs to be stateful and tight to the Model row (not globally), so we add hotkeyCopiedStates as a dictionary.
export default function Home() {
  const { theme, toggleTheme } = useTheme();
  const [data, setData] = useState<RankData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedUids, setExpandedUids] = useState<Set<number>>(new Set());
  const [expandedScoreUids, setExpandedScoreUids] = useState<Set<number>>(new Set());
  const [expandedHotkeyUids, setExpandedHotkeyUids] = useState<Set<number>>(new Set());
  const [expandedDominators, setExpandedDominators] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [onlyShowGroupModels, setOnlyShowGroupModels] = useState(false);
  const [onlyShowTeamModels, setOnlyShowTeamModels] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [hideIncompleteEnvs, setHideIncompleteEnvs] = useState<Set<string>>(new Set());
  const [sortColumn, setSortColumn] = useState<'rank' | 'age' | 'score' | 'size' | 'model' | string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({});

  const [hotkeyCopiedStates, setHotkeyCopiedStates] = useState<{ [uid: number]: boolean }>({});
  const [fetchingSizes, setFetchingSizes] = useState<Set<number>>(new Set());
  const [minerStatuses, setMinerStatuses] = useState<{ [uid: number]: string | null }>({});
  const [fetchingStatuses, setFetchingStatuses] = useState<Set<number>>(new Set());

  const fetchData = async (forceRefresh = false) => {
    if (forceRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const response = await fetch(`/api/rank?refresh=${forceRefresh}`);
      if (!response.ok) {
        throw new Error('Failed to fetch data');
      }
      const result: RankData = await response.json();
      setData(result);
    } catch (err: any) {
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (!data || !data.models) return;
    const modelsNeedingSize = data.models.filter(
      (model) => model.modelFullName && (model.modelSizeGB === null || model.modelSizeGB === undefined)
    );

    if (modelsNeedingSize.length === 0) return;

    let currentIndex = 0;
    let isCancelled = false;
    let batchSize = 10;
    let batchDelay = 1000;
    let consecutive429Errors = 0;
    
    const fetchBatch = async () => {
      if (isCancelled || currentIndex >= modelsNeedingSize.length) return;

      const batch = modelsNeedingSize.slice(currentIndex, currentIndex + batchSize);
      setFetchingSizes((prev) => {
        const next = new Set(prev);
        batch.forEach((model) => next.add(model.uid));
        return next;
      });

      const fetchPromises = batch.map(async (model): Promise<{ model: ModelData; retry: boolean }> => {
        try {
          // Prefer modelFullName for caching (UID can change over time)
          const apiUrl = model.modelFullName 
            ? `/api/model-size?model=${encodeURIComponent(model.modelFullName)}`
            : `/api/model-size?uid=${model.uid}`;
          const response = await fetch(apiUrl);
          if (response.status === 429) {
            consecutive429Errors++;
            console.warn(`Rate limited (429) for uid=${model.uid}. Adjusting batch size and delay.`);
            if (consecutive429Errors >= 2) {
              batchSize = Math.max(10, batchSize - 2);
              batchDelay = Math.min(2000, batchDelay + 1000);
              console.log(`Adjusted: batchSize=${batchSize}, batchDelay=${batchDelay}ms`);
            }
            return { model, retry: true };
          } else {
            consecutive429Errors = 0; // Reset counter on success
            if (response.ok) {
              const result = await response.json();
              if (result.modelSizeGB !== null && result.modelSizeGB !== undefined) {
                setData((prevData) => {
                  if (!prevData) return prevData;
                  return {
                    ...prevData,
                    models: prevData.models.map((m) =>
                      m.uid === model.uid ? { ...m, modelSizeGB: result.modelSizeGB } : m
                    ),
                  };
                });
              }
            }
            return { model, retry: false };
          }
        } catch (error) {
          console.error(`Failed to fetch size for uid=${model.uid}:`, error);
          return { model, retry: false };
        } finally {
          setFetchingSizes((prev) => {
            const next = new Set(prev);
            next.delete(model.uid);
            return next;
          });
        }
      });

      const results = await Promise.all(fetchPromises);
      const retryCount = results.filter(r => r.retry).length;
      if (retryCount > 0) {
        console.log(`${retryCount} models got 429 errors in this batch. Models will be retried on next refresh.`);
      }
      currentIndex += batch.length;
      if (!isCancelled && currentIndex < modelsNeedingSize.length) {
        setTimeout(fetchBatch, batchDelay);
      }
    };

    const timeoutId = setTimeout(fetchBatch, 1000);
    return () => {
      isCancelled = true;
      clearTimeout(timeoutId);
    };
  }, [data]);

  const handleRefresh = () => {
    fetchData(true);
  };

  const toggleExpand = (uid: number) => {
    const newExpanded = new Set(expandedUids);
    if (newExpanded.has(uid)) {
      newExpanded.delete(uid);
    } else {
      newExpanded.add(uid);
    }
    setExpandedUids(newExpanded);
  };

  const toggleScoreExpand = (uid: number) => {
    const next = new Set(expandedScoreUids);
    if (next.has(uid)) {
      next.delete(uid);
    } else {
      next.add(uid);
    }
    setExpandedScoreUids(next);
  };

  const toggleHotkeyExpand = (uid: number) => {
    const next = new Set(expandedHotkeyUids);
    if (next.has(uid)) {
      next.delete(uid);
    } else {
      next.add(uid);
    }
    setExpandedHotkeyUids(next);
  };

  const toggleDominatorExpand = (modelUid: number, dominatorUid: number) => {
    const key = `${modelUid}-${dominatorUid}`;
    const next = new Set(expandedDominators);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setExpandedDominators(next);
  };

  const scrollToUid = (uid: number) => {
    const rowElement = rowRefs.current[uid];
    if (rowElement) {
      rowElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      rowElement.style.transition = 'background-color 0.6s ease';
      const originalBg = rowElement.style.background;
      rowElement.style.background = 'rgba(255, 237, 74, 0.3)';
      setTimeout(() => {
        rowElement.style.background = originalBg;
        setTimeout(() => {
          rowElement.style.transition = '';
        }, 300);
      }, 1000);
    }
  };

  const formatScore = (score: number) => {
    return score.toFixed(2);
  };

  const scoreNames =
    data?.scoreOrder && data.scoreOrder.length > 0
      ? data.scoreOrder
      : (data?.models?.[0] ? Object.keys(data.models[0].scores) : []);

  const isMyModel = (modelName: string) => {
    const prefixes = data?.myModelPrefixes ?? [];
    if (!prefixes.length) return false;
    const lower = modelName.toLowerCase();
    return prefixes.some((p) => {
      const pref = p.toLowerCase();
      return lower.startsWith(pref) || lower.startsWith(pref + '/');
    });
  };

  const isTeamModel = (modelName: string) => {
    const prefixes = data?.teamModelPrefixes ?? [];
    if (!prefixes || !Array.isArray(prefixes) || prefixes.length === 0) {
      return false;
    }
    const lower = modelName.toLowerCase();
    return prefixes.some((p) => {
      if (!p || typeof p !== 'string') return false;
      const pref = p.toLowerCase().trim();
      if (!pref) return false;
      return lower.startsWith(pref) || lower.startsWith(pref + '/');
    });
  };

  const getAgeInDays = (firstBlk: number): number => {
    const current = data?.currentBlock;
    if (!current || !Number.isFinite(current) || !firstBlk || !Number.isFinite(firstBlk)) return 0;
    const deltaBlocks = current - firstBlk;
    if (!Number.isFinite(deltaBlocks) || deltaBlocks < 0) return 0;
    return (deltaBlocks * 12) / 86400;
  };

  const getAverageScore = (model: ModelData) => {
    if (!scoreNames || scoreNames.length === 0) return 0;
    const values = scoreNames
      .map((k) => model.scores[k])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (values.length === 0) return 0;
    const sum = values.reduce((acc, v) => acc + v, 0);
    return sum / values.length;
  };

  const allSortedModels = data?.models.sort((a, b) => b.points - a.points) || [];
  const modelsWithRank = allSortedModels.map((model, index) => ({
    ...model,
    rank: index + 1
  }));

  const sortedModels = (() => {
    let filtered = modelsWithRank;
    if (onlyShowGroupModels && onlyShowTeamModels) {
      filtered = filtered.filter((model) => 
        isMyModel(model.modelName) || isTeamModel(model.modelName)
      );
    } else if (onlyShowGroupModels) {
      filtered = filtered.filter((model) => isMyModel(model.modelName));
    } else if (onlyShowTeamModels) {
      filtered = filtered.filter((model) => isTeamModel(model.modelName));
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filtered = filtered.filter((model) => {
        if (model.uid.toString().includes(query)) {
          return true;
        }
        if (model.modelName.toLowerCase().includes(query)) {
          return true;
        }
        if (model.modelSizeGB !== null && model.modelSizeGB !== undefined) {
          if (model.modelSizeGB.toString().includes(query)) {
            return true;
          }
        }
        return false;
      });
    }
    if (hideIncompleteEnvs.size > 0) {
      filtered = filtered.filter((model) => {
        for (const env of hideIncompleteEnvs) {
          if (model.incompleteProblems?.includes(env)) {
            return false;
          }
        }
        return true;
      });
    }
    if (sortColumn) {
      filtered = [...filtered].sort((a, b) => {
        if (sortColumn === 'model') {
          // Sort by modelFullName if available, otherwise by modelName
          const aName = (a.modelFullName || a.modelName || '').toLowerCase();
          const bName = (b.modelFullName || b.modelName || '').toLowerCase();
          if (sortDirection === 'asc') {
            return aName.localeCompare(bName);
          } else {
            return bName.localeCompare(aName);
          }
        }
        
        let aValue: number;
        let bValue: number;
        if (sortColumn === 'rank') {
          aValue = a.rank || 0;
          bValue = b.rank || 0;
        } else if (sortColumn === 'age') {
          aValue = getAgeInDays(a.firstBlk);
          bValue = getAgeInDays(b.firstBlk);
        } else if (sortColumn === 'score') {
          aValue = getAverageScore(a);
          bValue = getAverageScore(b);
        } else if (sortColumn === 'size') {
          aValue = a.modelSizeGB ?? 0;
          bValue = b.modelSizeGB ?? 0;
        } else if (scoreNames.includes(sortColumn)) {
          // Sort by specific environment score
          aValue = a.scores[sortColumn] ?? 0;
          bValue = b.scores[sortColumn] ?? 0;
        } else {
          return 0;
        }
        if (sortDirection === 'asc') {
          return aValue - bValue;
        } else {
          return bValue - aValue;
        }
      });
    }
    return filtered;
  })();

  const getRankBadge = (rank: number) => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return null;
  };

  const formatAgeDays = (firstBlk: number) => {
    const current = data?.currentBlock;
    if (!current || !Number.isFinite(current) || !firstBlk || !Number.isFinite(firstBlk)) return '-';
    const deltaBlocks = current - firstBlk;
    if (!Number.isFinite(deltaBlocks) || deltaBlocks < 0) return '-';
    const days = (deltaBlocks * 12) / 86400;
    return `${days.toFixed(2)} d`;
  };

  const handleSort = (column: 'rank' | 'age' | 'score' | 'size' | 'model' | string) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  const handleCopyHotkey = async (uid: number, hotkey: string | null | undefined) => {
    if (!hotkey) {
      alert('No hotkey found');
      return;
    }
    let copied = false;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(hotkey);
        copied = true;
      } catch (err) {}
    }
    if (!copied) {
      try {
        const textArea = document.createElement("textarea");
        textArea.value = hotkey;
        textArea.style.position = "fixed";
        textArea.style.left = "-1000px";
        textArea.setAttribute('readonly', 'readonly');
        document.body.appendChild(textArea);
        textArea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (success) {
          copied = true;
        }
      } catch (e) {}
    }
    if (!copied) {
      alert('Copy failed (Clipboard API or fallback not supported)');
      return;
    }
    setHotkeyCopiedStates((prev) => ({ ...prev, [uid]: true }));
    setTimeout(() => {
      setHotkeyCopiedStates((prev) => ({ ...prev, [uid]: false }));
    }, 1000);
  };

  const handleFetchMinerStatus = async (uid: number, chuteId?: string | null) => {
    // If already fetching, don't fetch again
    if (fetchingStatuses.has(uid)) {
      return;
    }

    setFetchingStatuses((prev) => {
      const next = new Set(prev);
      next.add(uid);
      return next;
    });

    try {
      const params = new URLSearchParams({ uid: uid.toString() });
      if (chuteId) {
        params.append('chute_id', chuteId);
      }
      const response = await fetch(`/api/miner-status?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch miner status');
      }
      const result = await response.json();
      const chuteStatus = result?.chute_status || null;
      setMinerStatuses((prev) => ({ ...prev, [uid]: chuteStatus }));
    } catch (error) {
      console.error(`Failed to fetch miner status for uid=${uid}:`, error);
      setMinerStatuses((prev) => ({ ...prev, [uid]: null }));
    } finally {
      setFetchingStatuses((prev) => {
        const next = new Set(prev);
        next.delete(uid);
        return next;
      });
    }
  };

  return (
    <>
      <Head>
        <meta name="description" content="Bittensor Affine Model Dominance Rankings" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <main
        style={{
          padding: '22px',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
          color: theme === 'dark' ? '#f1f5f9' : '#0b1220',
          background: theme === 'dark'
            ? 'radial-gradient(1200px 600px at 20% 0%, rgba(30, 58, 138, 0.15), transparent 60%), radial-gradient(900px 500px at 90% 10%, rgba(15, 23, 42, 0.20), transparent 55%), linear-gradient(180deg, #0f172a 0%, #1e293b 40%, #0f172a 100%)'
            : 'radial-gradient(1200px 600px at 20% 0%, rgba(56, 189, 248, 0.10), transparent 60%), radial-gradient(900px 500px at 90% 10%, rgba(34, 211, 238, 0.10), transparent 55%), linear-gradient(180deg, #f7fbff 0%, #ffffff 40%, #fbfeff 100%)',
          minHeight: '100vh',
          position: 'relative'
        }}
      >
        {/* Theme Toggle Button */}
        <button
          onClick={toggleTheme}
          style={{
            position: 'fixed',
            top: '20px',
            right: '20px',
            zIndex: 1000,
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            border: theme === 'dark' ? '1px solid rgba(148, 163, 184, 0.3)' : '1px solid rgba(148, 163, 184, 0.2)',
            background: theme === 'dark' 
              ? 'rgba(30, 41, 59, 0.8)' 
              : 'rgba(255, 255, 255, 0.9)',
            backdropFilter: 'blur(10px)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: theme === 'dark'
              ? '0 4px 12px rgba(0, 0, 0, 0.3)'
              : '0 4px 12px rgba(0, 0, 0, 0.1)',
            transition: 'all 0.2s ease',
            color: theme === 'dark' ? '#fbbf24' : '#f59e0b'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.1)';
            e.currentTarget.style.background = theme === 'dark' 
              ? 'rgba(30, 41, 59, 0.95)' 
              : 'rgba(255, 255, 255, 1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
            e.currentTarget.style.background = theme === 'dark' 
              ? 'rgba(30, 41, 59, 0.8)' 
              : 'rgba(255, 255, 255, 0.9)';
          }}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? (
            <SunIcon width={24} height={24} />
          ) : (
            <MoonIcon width={24} height={24} />
          )}
        </button>
        <div style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginBottom: '20px' }}>
            <div style={{ textAlign: 'center', width: '100%' }}>
              {/* ... unchanged UI controls ... */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  gap: '24px',
                  justifyContent: 'center',
                  alignItems: 'center',
                  marginTop: 12,
                  fontSize: 13,
                  color: theme === 'dark' ? '#94a3b8' : '#3b556a',
                  width: '100%',
                }}
              >
                {/* ... unchanged filter controls ... */}
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    color: theme === 'dark' ? '#f1f5f9' : '#0b1220',
                    userSelect: 'none',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={onlyShowGroupModels}
                    onChange={(e) => setOnlyShowGroupModels(e.target.checked)}
                    style={{
                      width: '16px',
                      height: '16px',
                      cursor: 'pointer',
                      accentColor: theme === 'dark' ? '#60a5fa' : '#0ea5e9',
                    }}
                  />
                  <span>Group models</span>
                </label>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    color: theme === 'dark' ? '#f1f5f9' : '#0b1220',
                    userSelect: 'none',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={onlyShowTeamModels}
                    onChange={(e) => setOnlyShowTeamModels(e.target.checked)}
                    style={{
                      width: '16px',
                      height: '16px',
                      cursor: 'pointer',
                      accentColor: theme === 'dark' ? '#cbd05f' : '#adb05f',
                    }}
                  />
                  <span>Team models</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* ... error and info UI unchanged ... */}

        {error && (
          <div style={{ 
            padding: '10px', 
            backgroundColor: theme === 'dark' ? 'rgba(239, 68, 68, 0.2)' : '#fee', 
            color: theme === 'dark' ? '#fca5a5' : '#c00', 
            borderRadius: '5px', 
            marginBottom: '20px' 
          }}>
            Error: {error}
          </div>
        )}

        {data?.error && (
          <div style={{ 
            padding: '10px', 
            backgroundColor: theme === 'dark' ? 'rgba(234, 179, 8, 0.2)' : '#ffe', 
            color: theme === 'dark' ? '#fde047' : '#cc0', 
            borderRadius: '5px', 
            marginBottom: '20px' 
          }}>
            Warning: {data.error}
          </div>
        )}

        {loading && !data && (
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <div style={{ color: theme === 'dark' ? '#f1f5f9' : '#0b1220' }}>Loading...</div>
          </div>
        )}

        {data && (
          <div
            style={{
              width: '100%',
              maxWidth: '100%',
              borderRadius: 16,
              background: theme === 'dark' 
                ? 'rgba(30, 41, 59, 0.8)' 
                : 'rgba(255,255,255,0.7)',
              border: theme === 'dark'
                ? '1px solid rgba(148, 163, 184, 0.2)'
                : '1px solid rgba(148, 163, 184, 0.35)',
              boxShadow: theme === 'dark'
                ? '0 18px 45px rgba(0, 0, 0, 0.3)'
                : '0 18px 45px rgba(15, 23, 42, 0.08)',
              backdropFilter: 'blur(10px)'
            }}
          >
            <div
                style={{
                  maxHeight: 820,
                  overflowY: 'auto',
                  overflowX: 'auto',
                  scrollbarWidth: 'thin',
                  scrollbarColor: theme === 'dark' ? '#475569 #1e293b' : '#36a3fc #f2f6fa',
                  borderRadius: 12,
                  boxShadow: theme === 'dark'
                    ? "0 6px 16px rgba(0, 0, 0, 0.2)"
                    : "0 6px 16px rgba(56,107,180,0.04)",
                  width: '100%',
                  maxWidth: '100%'
                }}
                className={`modern-scrollbar ${theme === 'dark' ? 'dark' : ''}`}
            >
              <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: '14px', width: '100%', tableLayout: 'auto' }}>
                <thead>
                  {/* ... unchanged table head ... */}
                  <tr
                    style={{
                      position: 'sticky',
                      top: 0,
                      zIndex: 2,
                      background: theme === 'dark'
                        ? 'linear-gradient(180deg, rgba(30, 41, 59, 0.95) 0%, rgba(15, 23, 42, 0.90) 100%)'
                        : 'linear-gradient(180deg, rgba(226, 246, 255, 0.95) 0%, rgba(240, 251, 255, 0.90) 100%)',
                      backdropFilter: 'blur(10px)'
                    }}
                  >
                    {[
                      'Rank',
                      'UID',
                      'Model',
                      'Age',
                      'Size',
                      'Points',
                      'Weight',
                      'Dominators',
                      'Scores'
                    ].map((h, i, arr) => {
                      const isSortable = h === 'Rank' || h === 'Model' || h === 'Age' || h === 'Size' || h === 'Scores';
                      const isActive = (h === 'Rank' && sortColumn === 'rank') || (h === 'Model' && sortColumn === 'model') || (h === 'Age' && sortColumn === 'age') || (h === 'Size' && sortColumn === 'size') || (h === 'Scores' && sortColumn === 'score');
                      const isModelColumn = h === 'Model';
                      const shouldCenter = h !== 'Dominators' && h !== 'Scores' && h !== 'Model';
                      return (
                        <th
                          key={h}
                          onClick={isSortable ? () => handleSort(h === 'Rank' ? 'rank' : h === 'Model' ? 'model' : h === 'Age' ? 'age' : h === 'Size' ? 'size' : h === 'Scores' ? 'score' : 'rank') : undefined}
                          style={{
                            padding: '6px 6px',
                            textAlign: shouldCenter ? 'center' : 'left',
                            fontSize: 12,
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            color: theme === 'dark' ? '#cbd5e1' : '#0f3550',
                            borderBottom: theme === 'dark'
                              ? '1px solid rgba(148, 163, 184, 0.3)'
                              : '1px solid rgba(148, 163, 184, 0.55)',
                            borderRight: i === arr.length - 1 ? 'none' : (theme === 'dark'
                              ? '1px solid rgba(51, 65, 85, 0.5)'
                              : '1px solid rgba(226, 232, 240, 0.9)'),
                            cursor: isSortable ? 'pointer' : 'default',
                            userSelect: 'none',
                            position: 'relative',
                            background: isActive ? 'rgba(14, 165, 233, 0.1)' : 'transparent',
                            transition: 'background-color 0.2s ease',
                            ...(isModelColumn && {
                              whiteSpace: 'nowrap'
                            })
                          }}
                          onMouseEnter={(e) => {
                            if (isSortable) {
                              e.currentTarget.style.background = isActive ? 'rgba(14, 165, 233, 0.15)' : 'rgba(14, 165, 233, 0.05)';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (isSortable) {
                              e.currentTarget.style.background = isActive ? 'rgba(14, 165, 233, 0.1)' : 'transparent';
                            }
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span>{h}</span>
                            {isSortable && (
                              <span style={{ fontSize: '10px', color: isActive ? '#0ea5e9' : '#94a3b8' }}>
                                {isActive ? (sortDirection === 'asc' ? '▲' : '▼') : '⇅'}
                              </span>
                            )}
                          </div>
                        </th>
                      );
                    })}
                    {scoreNames.map((env) => {
                      const isActive = sortColumn === env;
                      const isHidingIncomplete = hideIncompleteEnvs.has(env);
                      return (
                        <th
                          key={env}
                          onClick={() => handleSort(env)}
                          style={{
                            padding: '6px 6px',
                            textAlign: 'center',
                            fontSize: 12,
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            color: theme === 'dark' ? '#cbd5e1' : '#0f3550',
                            borderBottom: theme === 'dark'
                              ? '1px solid rgba(148, 163, 184, 0.3)'
                              : '1px solid rgba(148, 163, 184, 0.55)',
                            borderRight: theme === 'dark'
                              ? '1px solid rgba(51, 65, 85, 0.5)'
                              : '1px solid rgba(226, 232, 240, 0.9)',
                            cursor: 'pointer',
                            userSelect: 'none',
                            position: 'relative',
                            background: isActive ? 'rgba(14, 165, 233, 0.1)' : 'transparent',
                            transition: 'background-color 0.2s ease',
                            whiteSpace: 'nowrap'
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = isActive ? 'rgba(14, 165, 233, 0.15)' : 'rgba(14, 165, 233, 0.05)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = isActive ? 'rgba(14, 165, 233, 0.1)' : 'transparent';
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                            <span>{env}</span>
                            <span style={{ fontSize: '10px', color: isActive ? '#0ea5e9' : '#94a3b8' }}>
                              {isActive ? (sortDirection === 'asc' ? '▲' : '▼') : '⇅'}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setHideIncompleteEnvs((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(env)) {
                                    next.delete(env);
                                  } else {
                                    next.add(env);
                                  }
                                  return next;
                                });
                              }}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '2px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                marginLeft: '4px'
                              }}
                              title={isHidingIncomplete ? `Show incomplete ${env} models` : `Hide incomplete ${env} models`}
                            >
                              {isHidingIncomplete ? (
                                <EyeSlashIcon width={16} height={16} style={{ color: theme === 'dark' ? '#64748b' : '#94a3b8' }} />
                              ) : (
                                <EyeIcon width={16} height={16} style={{ color: theme === 'dark' ? '#cbd5e1' : '#0f3550' }} />
                              )}
                            </button>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sortedModels.map((model, index) => {
                    const isExpanded = expandedUids.has(model.uid);
                    const isScoreExpanded = expandedScoreUids.has(model.uid);
                    const dominatorCount = model.dominance.dominators.length;
                    const avgScore = getAverageScore(model);
                    const rank = model.rank ?? (index + 1);
                    const badge = getRankBadge(rank);
                    const hasWeight = model.weight > 0;
                    const isDominated = model.dominance.isDominated;
                    const myRow = isMyModel(model.modelName);
                    const teamRow = isTeamModel(model.modelName);

                    // Categorize dominators into current and future
                    const isFutureDominator = (dominator: ModelData['dominance']['dominators'][0]) => {
                      // Check if dominator has any ! sign (incomplete problems) in any environment
                      if (!dominator.incompleteProblems || dominator.incompleteProblems.length === 0) {
                        return false;
                      }
                      // Check if any environment in scoreNames has incomplete problems
                      return scoreNames.some(env => dominator.incompleteProblems?.includes(env));
                    };

                    const currentDominators = model.dominance.dominators.filter(d => !isFutureDominator(d));
                    const futureDominators = model.dominance.dominators.filter(d => isFutureDominator(d));
                    const currentCount = currentDominators.length;
                    const futureCount = futureDominators.length;

                    const rowBg = hasWeight
                      ? theme === 'dark'
                        ? 'linear-gradient(180deg, rgba(14, 165, 233, 0.15) 0%, rgba(34, 211, 238, 0.10) 100%)'
                        : 'linear-gradient(180deg, rgba(219, 251, 255, 0.85) 0%, rgba(240, 253, 250, 0.70) 100%)'
                      : isDominated
                        ? theme === 'dark'
                          ? 'linear-gradient(180deg, rgba(251, 146, 60, 0.15) 0%, rgba(245, 158, 11, 0.10) 100%)'
                          : 'linear-gradient(180deg, rgba(255, 247, 237, 0.95) 0%, rgba(255, 251, 235, 0.85) 100%)'
                        : index % 2 === 0
                          ? theme === 'dark' ? '#1e293b' : '#ffffff'
                          : theme === 'dark' ? 'rgba(30, 41, 59, 0.5)' : 'rgba(248, 250, 252, 0.75)';

                    const leftAccent = hasWeight
                      ? '4px solid rgba(14, 165, 233, 0.9)'
                      : badge
                        ? '4px solid rgba(245, 158, 11, 0.85)'
                        : isDominated
                          ? '4px solid rgba(251, 146, 60, 0.8)'
                          : '4px solid transparent';

                    const finalRowBg = rowBg;
                    const finalLeftAccent = leftAccent;
                    
                    const modelNameColor = myRow
                      ? theme === 'dark' ? '#4ade80' : '#22c55e'
                      : teamRow
                        ? theme === 'dark' ? '#cbd05f' : '#adb05f'
                        : theme === 'dark' ? '#f1f5f9' : '#0b1220';
                    
                    return (
                      <tr
                        key={model.uid}
                        ref={(el) => {
                          rowRefs.current[model.uid] = el;
                        }}
                        style={{
                          background: finalRowBg,
                          borderLeft: finalLeftAccent
                        }}
                      >
                        <td style={{ 
                          padding: '12px', 
                          borderBottom: theme === 'dark' 
                            ? '1px solid rgba(51, 65, 85, 0.5)' 
                            : '1px solid rgba(226, 232, 240, 0.9)', 
                          textAlign: 'center' 
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                            {!badge && (
                              <span style={{ fontWeight: 800, color: theme === 'dark' ? '#f1f5f9' : '#0b1220' }}>{rank}</span>
                            )}
                            {badge && (
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: 26,
                                  height: 26,
                                  borderRadius: 999,
                                  background: theme === 'dark' ? 'rgba(30, 41, 59, 0.8)' : 'rgba(255,255,255,0.8)',
                                  border: theme === 'dark'
                                    ? '1px solid rgba(148, 163, 184, 0.3)'
                                    : '1px solid rgba(148, 163, 184, 0.45)',
                                  boxShadow: theme === 'dark'
                                    ? '0 6px 14px rgba(0, 0, 0, 0.2)'
                                    : '0 6px 14px rgba(15, 23, 42, 0.10)'
                                }}
                                title={`Top ${rank}`}
                              >
                                {badge}
                              </span>
                            )}
                          </div>
                        </td>
                        <td style={{ 
                          padding: '12px', 
                          borderBottom: theme === 'dark' 
                            ? '1px solid rgba(51, 65, 85, 0.5)' 
                            : '1px solid rgba(226, 232, 240, 0.9)', 
                          textAlign: 'center' 
                        }}>
                          <span
                            style={{
                              fontVariantNumeric: 'tabular-nums',
                              fontWeight: 800,
                              color: theme === 'dark' ? '#f1f5f9' : '#0f172a'
                            }}
                          >
                            {model.uid}
                          </span>
                        </td>
                         <td style={{ 
                           padding: '12px', 
                           borderBottom: theme === 'dark' 
                             ? '1px solid rgba(51, 65, 85, 0.5)' 
                             : '1px solid rgba(226, 232, 240, 0.9)',
                           width: '1%'
                         }}>
                           <div style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                             {model.modelFullName ? (
                               <a
                                 href="#"
                                 style={{
                                   color: modelNameColor,
                                   textDecoration: 'none',
                                   fontWeight: 700
                                 }}
                                 onClick={(e) => {
                                   e.preventDefault();
                                   window.open(`https://huggingface.co/${model.modelFullName}`, '_blank', 'noopener,noreferrer');
                                 }}
                                 onMouseEnter={(e) => {
                                   e.currentTarget.style.textDecoration = 'underline';
                                 }}
                                 onMouseLeave={(e) => {
                                   e.currentTarget.style.textDecoration = 'none';
                                 }}
                                 title={model.modelFullName} // show full name on hover
                               >
                                 {/* Show truncated model full name here */}
                                 {truncateModelFullName(model.modelFullName)}
                               </a>
                             ) : (
                               <span style={{ color: modelNameColor }}>{model.modelName}</span>
                             )}
                           </div>
                           <div style={{ 
                             marginTop: 4, 
                             fontSize: 12, 
                             color: theme === 'dark' ? '#94a3b8' : '#3b556a', 
                             display: 'flex', 
                             alignItems: 'center', 
                             gap: 10, 
                             position: 'relative', 
                             flexWrap: 'wrap' 
                           }}>
                             <button
                               onClick={(e) => {
                                 e.stopPropagation();
                                 handleFetchMinerStatus(model.uid, model.chute_id);
                               }}
                               disabled={fetchingStatuses.has(model.uid)}
                               style={{
                                 padding: '4px 10px',
                                 fontSize: 11,
                                 fontWeight: 600,
                                 borderRadius: 12,
                                 border: 'none',
                                 cursor: fetchingStatuses.has(model.uid) ? 'wait' : 'pointer',
                                 background: minerStatuses[model.uid] === 'hot'
                                   ? 'rgba(239, 68, 68, 0.15)'
                                   : minerStatuses[model.uid] === 'cold'
                                   ? 'rgba(59, 130, 246, 0.15)'
                                   : 'rgba(148, 163, 184, 0.15)',
                                 color: minerStatuses[model.uid] === 'hot'
                                   ? '#dc2626'
                                   : minerStatuses[model.uid] === 'cold'
                                   ? '#2563eb'
                                   : '#64748b',
                                 transition: 'all 0.2s ease',
                                 whiteSpace: 'nowrap',
                                 userSelect: 'none'
                               }}
                               onMouseEnter={(e) => {
                                 if (!fetchingStatuses.has(model.uid) && !minerStatuses[model.uid]) {
                                   e.currentTarget.style.background = 'rgba(148, 163, 184, 0.25)';
                                 }
                               }}
                               onMouseLeave={(e) => {
                                 if (!fetchingStatuses.has(model.uid) && !minerStatuses[model.uid]) {
                                   e.currentTarget.style.background = 'rgba(148, 163, 184, 0.15)';
                                 }
                               }}
                             >
                               {fetchingStatuses.has(model.uid)
                                 ? 'Loading...'
                                 : minerStatuses[model.uid]
                                 ? (minerStatuses[model.uid] as string)?.charAt(0).toUpperCase() + (minerStatuses[model.uid] as string)?.slice(1)
                                 : 'Status'}
                             </button>
                             {model.chute_id && (
                               <a
                                 href={`https://chutes.ai/app/chute/${model.chute_id}`}
                                 target="_blank"
                                 rel="noopener noreferrer"
                                 style={{
                                 color: theme === 'dark' ? '#60a5fa' : '#0369a1',
                                 textDecoration: 'none',
                                 fontWeight: 600
                               }}
                                 onMouseEnter={(e) => {
                                   e.currentTarget.style.textDecoration = 'underline';
                                 }}
                                 onMouseLeave={(e) => {
                                   e.currentTarget.style.textDecoration = 'none';
                                 }}
                               >
                                 chute_id
                               </a>
                             )}
                             {model.coldkey && (
                               <a
                                 href={`https://taomarketcap.com/coldkey/${model.coldkey}`}
                                 target="_blank"
                                 rel="noopener noreferrer"
                                 style={{
                                   color: theme === 'dark' ? '#60a5fa' : '#0369a1',
                                   textDecoration: 'none',
                                   fontWeight: 600
                                 }}
                                 onMouseEnter={(e) => {
                                   e.currentTarget.style.textDecoration = 'underline';
                                 }}
                                 onMouseLeave={(e) => {
                                   e.currentTarget.style.textDecoration = 'none';
                                 }}
                               >
                                 coldkey
                               </a>
                             )}
                            {model.hotkey && (
                              <div
                                style={{
                                  marginTop: 4,
                                  cursor: 'pointer',
                                  color: theme === 'dark' ? '#60a5fa' : '#0369a1',
                                  fontWeight: 800,
                                  fontSize: 12,
                                  userSelect: 'none',
                                  display: 'flex',
                                  alignItems: 'center',
                                  position: 'relative'
                                }}
                                title="Click to copy hotkey"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  await handleCopyHotkey(model.uid, model.hotkey);
                                }}
                              >
                                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                                  hotkey{' '}
                                  <ClipboardIcon width={16} height={16} style={{ marginLeft: 3, verticalAlign: 'middle' }} />
                                </span>
                                {hotkeyCopiedStates[model.uid] && (
                                  <span
                                    style={{
                                      position: 'absolute',
                                      left: '100%',
                                      top: '50%',
                                      transform: 'translateY(-50%)',
                                      marginLeft: 10,
                                      background: theme === 'dark' ? 'rgba(30, 41, 59, 0.95)' : 'rgba(0,0,0,0.78)',
                                      color: theme === 'dark' ? '#f1f5f9' : '#fff',
                                      fontWeight: 600,
                                      padding: '4px 12px',
                                      borderRadius: 9,
                                      fontSize: 12,
                                      boxShadow: '0 1px 4px rgba(0,0,0,0.10)',
                                      zIndex: 10,
                                      pointerEvents: 'none',
                                      whiteSpace: 'nowrap'
                                    }}
                                  >
                                    Copied hotkey
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                        {/* ... rest of the table row remains unchanged ... */}
                        <td style={{ 
                          padding: '12px', 
                          borderBottom: theme === 'dark' 
                            ? '1px solid rgba(51, 65, 85, 0.5)' 
                            : '1px solid rgba(226, 232, 240, 0.9)', 
                          textAlign: 'center' 
                        }}>
                          <div style={{ fontWeight: 900, color: theme === 'dark' ? '#f1f5f9' : '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
                            {formatAgeDays(model.firstBlk)}
                          </div>
                          <div style={{ marginTop: 4, fontSize: 12, color: theme === 'dark' ? '#94a3b8' : '#3b556a', fontVariantNumeric: 'tabular-nums' }}>
                            FirstBlk: {model.firstBlk}
                          </div>
                        </td>
                        <td style={{ 
                          padding: '12px', 
                          borderBottom: theme === 'dark' 
                            ? '1px solid rgba(51, 65, 85, 0.5)' 
                            : '1px solid rgba(226, 232, 240, 0.9)', 
                          textAlign: 'center' 
                        }}>
                          {model.modelSizeGB !== null && model.modelSizeGB !== undefined ? (
                            <div style={{ fontWeight: 900, color: theme === 'dark' ? '#f87171' : '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
                              {model.modelSizeGB.toFixed(2)} GB
                            </div>
                          ) : fetchingSizes.has(model.uid) && model.modelFullName ? (
                            <div style={{ fontSize: 12, color: theme === 'dark' ? '#60a5fa' : '#0ea5e9', fontStyle: 'italic' }}>
                              Loading...
                            </div>
                          ) : (
                            <div style={{ fontSize: 12, color: theme === 'dark' ? '#64748b' : '#94a3b8', fontStyle: 'italic' }}>
                              -
                            </div>
                          )}
                        </td>
                        <td style={{ 
                          padding: '12px', 
                          borderBottom: theme === 'dark' 
                            ? '1px solid rgba(51, 65, 85, 0.5)' 
                            : '1px solid rgba(226, 232, 240, 0.9)', 
                          textAlign: 'center' 
                        }}>
                          <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 800, color: theme === 'dark' ? '#f1f5f9' : '#0f172a' }}>
                            {formatScore(model.points)}
                          </span>
                        </td>
                        <td style={{ 
                          padding: '12px', 
                          borderBottom: theme === 'dark' 
                            ? '1px solid rgba(51, 65, 85, 0.5)' 
                            : '1px solid rgba(226, 232, 240, 0.9)', 
                          textAlign: 'center' 
                        }}>
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: 8,
                              padding: '6px 10px',
                              borderRadius: 999,
                              fontVariantNumeric: 'tabular-nums',
                              fontWeight: 800,
                              color: hasWeight 
                                ? (theme === 'dark' ? '#bfdbfe' : '#003b5c')
                                : (theme === 'dark' ? '#cbd5e1' : '#334155'),
                              background: hasWeight
                                ? theme === 'dark'
                                  ? 'linear-gradient(180deg, rgba(14,165,233,0.25) 0%, rgba(34,211,238,0.18) 100%)'
                                  : 'linear-gradient(180deg, rgba(14,165,233,0.18) 0%, rgba(34,211,238,0.12) 100%)'
                                : theme === 'dark'
                                  ? 'rgba(30, 41, 59, 0.6)'
                                  : 'rgba(241, 245, 249, 0.8)',
                              border: hasWeight
                                ? theme === 'dark'
                                  ? '1px solid rgba(14,165,233,0.5)'
                                  : '1px solid rgba(14,165,233,0.35)'
                                : theme === 'dark'
                                  ? '1px solid rgba(148,163,184,0.3)'
                                  : '1px solid rgba(148,163,184,0.35)'
                            }}
                            title={hasWeight ? 'Active (weight > 0)' : 'Inactive (weight = 0)'}
                          >
                            <span
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: 999,
                                background: hasWeight ? (theme === 'dark' ? '#60a5fa' : '#0ea5e9') : (theme === 'dark' ? '#64748b' : '#94a3b8')
                              }}
                            />
                            {formatScore(model.weight)}
                          </span>
                        </td>
                        <td style={{ 
                          padding: '12px', 
                          borderBottom: theme === 'dark' 
                            ? '1px solid rgba(51, 65, 85, 0.5)' 
                            : '1px solid rgba(226, 232, 240, 0.9)' 
                        }}>
                          <div
                            onClick={() => toggleExpand(model.uid)}
                            style={{
                              cursor: dominatorCount > 0 ? 'pointer' : 'default',
                              color: dominatorCount > 0 
                                ? (theme === 'dark' ? '#60a5fa' : '#0369a1')
                                : (theme === 'dark' ? '#94a3b8' : '#64748b'),
                              fontWeight: dominatorCount > 0 ? 800 : 600,
                              userSelect: 'none'
                            }}
                          >
                            {dominatorCount > 0 ? (
                              <>
                                {isExpanded ? '▼' : '▶'} {dominatorCount} ({currentCount}/{futureCount}) dominator{dominatorCount !== 1 ? 's' : ''}
                              </>
                            ) : (
                              '0 dominators'
                            )}
                          </div>
                          {isExpanded && dominatorCount > 0 && (
                            <div
                              style={{
                                marginTop: '10px',
                                padding: '10px',
                                background: theme === 'dark' 
                                  ? 'rgba(15, 23, 42, 0.8)' 
                                  : 'rgba(255,255,255,0.75)',
                                borderRadius: '10px',
                                border: theme === 'dark'
                                  ? '1px solid rgba(148, 163, 184, 0.2)'
                                  : '1px solid rgba(148, 163, 184, 0.35)'
                              }}
                            >
                              {/* Current Dominators */}
                              {currentCount > 0 && (
                                <>
                                  <div style={{ 
                                    fontWeight: 800, 
                                    color: theme === 'dark' ? '#cbd5e1' : '#0f3550', 
                                    marginBottom: '10px',
                                    fontSize: '14px'
                                  }}>
                                    Current Dominators:
                                  </div>
                                  {currentDominators.map((dominator, dominatorIndex) => {
                                const dominatorKey = `${model.uid}-${dominator.uid}`;
                                const isDominatorExpanded = expandedDominators.has(dominatorKey);
                                const isLastCurrentDominator = dominatorIndex === currentDominators.length - 1;
                                const dominatorModel = data?.models.find(m => m.uid === dominator.uid);
                                const dominatorAge = dominatorModel ? formatAgeDays(dominatorModel.firstBlk) : '-';
                                return (
                                  <div
                                    key={dominator.uid}
                                    style={{
                                      marginBottom: isLastCurrentDominator ? 0 : '10px',
                                      paddingBottom: isLastCurrentDominator ? 0 : '10px',
                                      borderBottom: isLastCurrentDominator 
                                        ? 'none' 
                                        : (theme === 'dark' ? '1px solid rgba(51, 65, 85, 0.5)' : '1px solid #eee')
                                    }}
                                  >
                                    <div
                                      style={{
                                        display: 'flex',
                                        alignItems: 'start',
                                        justifyContent: 'space-around',
                                        gap: 1,
                                        marginBottom: '1px'
                                      }}
                                    >
                                      <div
                                        onClick={() => toggleDominatorExpand(model.uid, dominator.uid)}
                                        style={{
                                          cursor: 'pointer',
                                          fontWeight: 'bold',
                                          color: theme === 'dark' ? '#60a5fa' : '#0369a1',
                                          userSelect: 'none',
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 6,
                                          flex: 1
                                        }}
                                        onMouseEnter={(e) => {
                                          e.currentTarget.style.textDecoration = 'underline';
                                        }}
                                        onMouseLeave={(e) => {
                                          e.currentTarget.style.textDecoration = 'none';
                                        }}
                                      >
                                        <span>{isDominatorExpanded ? '▼' : '▶'}</span>
                                        <span>UID {dominator.uid}: {dominator.modelName}</span>
                                      </div>
                                      <div
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 6,
                                          fontSize: '12px',
                                          color: theme === 'dark' ? '#94a3b8' : '#64748b',
                                          fontVariantNumeric: 'tabular-nums',
                                          marginRight: '4px'
                                        }}
                                      >
                                        {dominatorAge}
                                      </div>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          // Unclick group models or team models buttons if they are clicked
                                          const needsUnclick = onlyShowGroupModels || onlyShowTeamModels;
                                          if (onlyShowGroupModels) {
                                            setOnlyShowGroupModels(false);
                                          }
                                          if (onlyShowTeamModels) {
                                            setOnlyShowTeamModels(false);
                                          }
                                          // Then scroll to uid - delay if we unclicked filters to allow re-render
                                          if (needsUnclick) {
                                            setTimeout(() => {
                                              scrollToUid(dominator.uid);
                                            }, 100);
                                          } else {
                                            scrollToUid(dominator.uid);
                                          }
                                        }}
                                        style={{
                                          padding: '1px 1px',
                                          fontSize: '16px',
                                          fontWeight: 600,
                                          color: theme === 'dark' ? '#60a5fa' : '#0369a1',
                                          background: theme === 'dark' 
                                            ? 'rgba(96, 165, 250, 0.15)' 
                                            : 'rgba(3, 105, 161, 0.1)',
                                          border: 'none',
                                          borderRadius: '4px',
                                          cursor: 'pointer',
                                          whiteSpace: 'nowrap',
                                          transition: 'all 0.2s ease'
                                        }}
                                        onMouseEnter={(e) => {
                                          e.currentTarget.style.background = theme === 'dark' 
                                            ? 'rgba(96, 165, 250, 0.25)' 
                                            : 'rgba(3, 105, 161, 0.2)';
                                        }}
                                        onMouseLeave={(e) => {
                                          e.currentTarget.style.background = theme === 'dark' 
                                            ? 'rgba(96, 165, 250, 0.15)' 
                                            : 'rgba(3, 105, 161, 0.1)';
                                        }}
                                        title={`Scroll to UID ${dominator.uid}`}
                                      >
                                        🏃‍♂️‍➡️
                                      </button>
                                    </div>
                                    {isDominatorExpanded && (
                                      <div style={{ display: 'flex', gap: 14, marginTop: '10px' }}>
                                        {/* Left: margins - styled like the right "dominator's own scores" panel */}
                                        <div
                                          style={{
                                            minWidth: 260,
                                            paddingLeft: 0,
                                            borderLeft: 'none',
                                            fontSize: 12,
                                            color: theme === 'dark' ? '#f1f5f9' : '#0b1220',
                                          }}
                                        >
                                          <div style={{ fontWeight: 800, color: theme === 'dark' ? '#cbd5e1' : '#0f3550', marginBottom: 6 }}>
                                            Difference score:
                                          </div>
                                          {Object.entries(dominator.margins).map(([env, margin]) => {
                                            const dominatorScore = dominator.scores?.[env] ?? 0;
                                            const targetEpsilon = model.epsilonThresholds[env] ?? 0;
                                            const difference = dominatorScore - targetEpsilon;
                                            const showDifference = difference >= 0 && Number.isFinite(difference);

                                            return (
                                              <div key={env} style={{ marginBottom: 2 }}>
                                                {env}:{' '}
                                                <span style={{ fontVariantNumeric: 'tabular-nums', color: theme === 'dark' ? '#f1f5f9' : '#0b1220' }}>
                                                  +{formatScore(margin)}
                                                </span>
                                                {showDifference && (
                                                  <span
                                                    style={{
                                                      marginLeft: 6,
                                                      color: theme === 'dark' ? '#4ade80' : '#16a34a',
                                                      fontWeight: 700
                                                    }}
                                                  >
                                                    (+{formatScore(difference)})
                                                  </span>
                                                )}
                                              </div>
                                            );
                                          })}
                                        </div>

                                        {/* Right: dominator's own scores (full info) */}
                                        <div
                                          style={{
                                            flex: 1,
                                            paddingLeft: 12,
                                            borderLeft: theme === 'dark'
                                              ? '1px solid rgba(148, 163, 184, 0.2)'
                                              : '1px solid rgba(148, 163, 184, 0.25)',
                                            fontSize: 12,
                                            color: theme === 'dark' ? '#f1f5f9' : '#0b1220'
                                          }}
                                        >
                                          <div style={{ fontWeight: 800, color: theme === 'dark' ? '#cbd5e1' : '#0f3550', marginBottom: 6 }}>
                                            Dominator scores
                                          </div>
                                          {scoreNames.map((env) => (
                                            <div key={env} style={{ marginBottom: 2 }}>
                                              {env}:{' '}
                                              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                                                {formatScore(dominator.scores?.[env] ?? 0)}
                                              </span>
                                              {dominator.epsilonThresholds?.[env] !== undefined && (
                                                <span style={{ color: theme === 'dark' ? '#94a3b8' : '#64748b' }}>
                                                  {' '}[{formatScore(dominator.epsilonThresholds[env] ?? 0)}]
                                                </span>
                                              )}
                                              {dominator.sampleCounts?.[env] !== undefined && (
                                                <span style={{ color: theme === 'dark' ? '#94a3b8' : '#64748b' }}>
                                                  {' '} / {dominator.sampleCounts[env]}
                                                </span>
                                              )}
                                              {dominator.incompleteProblems?.includes(env) && (
                                                <span style={{ marginLeft: 6, color: theme === 'dark' ? '#f87171' : '#ef4444', fontWeight: 900 }}>!</span>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                                  })}
                                  {/* Grey line separator */}
                                  {futureCount > 0 && (
                                    <div
                                      style={{
                                        marginTop: '15px',
                                        marginBottom: '15px',
                                        borderBottom: theme === 'dark'
                                          ? '1px solid rgba(148, 163, 184, 0.3)'
                                          : '1px solid rgba(148, 163, 184, 0.5)',
                                        width: '100%'
                                      }}
                                    />
                                  )}
                                </>
                              )}
                              {/* Future Dominators */}
                              {futureCount > 0 && (
                                <>
                                  <div style={{ 
                                    fontWeight: 800, 
                                    color: theme === 'dark' ? '#cbd5e1' : '#0f3550', 
                                    marginBottom: '10px',
                                    marginTop: currentCount > 0 ? '0' : '0',
                                    fontSize: '14px'
                                  }}>
                                    Future Dominators:
                                  </div>
                                  {futureDominators.map((dominator, dominatorIndex) => {
                                    const dominatorKey = `${model.uid}-${dominator.uid}`;
                                    const isDominatorExpanded = expandedDominators.has(dominatorKey);
                                    const isLastFutureDominator = dominatorIndex === futureDominators.length - 1;
                                    const dominatorModel = data?.models.find(m => m.uid === dominator.uid);
                                    const dominatorAge = dominatorModel ? formatAgeDays(dominatorModel.firstBlk) : '-';
                                    return (
                                      <div
                                        key={dominator.uid}
                                        style={{
                                          marginBottom: isLastFutureDominator ? 0 : '10px',
                                          paddingBottom: isLastFutureDominator ? 0 : '10px',
                                          borderBottom: isLastFutureDominator 
                                            ? 'none' 
                                            : (theme === 'dark' ? '1px solid rgba(51, 65, 85, 0.5)' : '1px solid #eee')
                                        }}
                                      >
                                        <div
                                          style={{
                                            display: 'flex',
                                            alignItems: 'start',
                                            justifyContent: 'space-around',
                                            gap: 1,
                                            marginBottom: '1px'
                                          }}
                                        >
                                          <div
                                            onClick={() => toggleDominatorExpand(model.uid, dominator.uid)}
                                            style={{
                                              cursor: 'pointer',
                                              fontWeight: 'bold',
                                              color: theme === 'dark' ? '#60a5fa' : '#0369a1',
                                              userSelect: 'none',
                                              display: 'flex',
                                              alignItems: 'center',
                                              gap: 6,
                                              flex: 1
                                            }}
                                            onMouseEnter={(e) => {
                                              e.currentTarget.style.textDecoration = 'underline';
                                            }}
                                            onMouseLeave={(e) => {
                                              e.currentTarget.style.textDecoration = 'none';
                                            }}
                                          >
                                            <span>{isDominatorExpanded ? '▼' : '▶'}</span>
                                            <span>UID {dominator.uid}: {dominator.modelName}</span>
                                          </div>
                                          <div
                                            style={{
                                              display: 'flex',
                                              alignItems: 'center',
                                              gap: 6,
                                              fontSize: '12px',
                                              color: theme === 'dark' ? '#94a3b8' : '#64748b',
                                              fontVariantNumeric: 'tabular-nums',
                                              marginRight: '4px'
                                            }}
                                          >
                                            {dominatorAge}
                                          </div>
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              // Unclick group models or team models buttons if they are clicked
                                              const needsUnclick = onlyShowGroupModels || onlyShowTeamModels;
                                              if (onlyShowGroupModels) {
                                                setOnlyShowGroupModels(false);
                                              }
                                              if (onlyShowTeamModels) {
                                                setOnlyShowTeamModels(false);
                                              }
                                              // Then scroll to uid - delay if we unclicked filters to allow re-render
                                              if (needsUnclick) {
                                                setTimeout(() => {
                                                  scrollToUid(dominator.uid);
                                                }, 100);
                                              } else {
                                                scrollToUid(dominator.uid);
                                              }
                                            }}
                                            style={{
                                              padding: '1px 1px',
                                              fontSize: '16px',
                                              fontWeight: 600,
                                              color: theme === 'dark' ? '#60a5fa' : '#0369a1',
                                              background: theme === 'dark' 
                                                ? 'rgba(96, 165, 250, 0.15)' 
                                                : 'rgba(3, 105, 161, 0.1)',
                                              border: 'none',
                                              borderRadius: '4px',
                                              cursor: 'pointer',
                                              whiteSpace: 'nowrap',
                                              transition: 'all 0.2s ease'
                                            }}
                                            onMouseEnter={(e) => {
                                              e.currentTarget.style.background = theme === 'dark' 
                                                ? 'rgba(96, 165, 250, 0.25)' 
                                                : 'rgba(3, 105, 161, 0.2)';
                                            }}
                                            onMouseLeave={(e) => {
                                              e.currentTarget.style.background = theme === 'dark' 
                                                ? 'rgba(96, 165, 250, 0.15)' 
                                                : 'rgba(3, 105, 161, 0.1)';
                                            }}
                                            title={`Scroll to UID ${dominator.uid}`}
                                          >
                                            🏃‍♂️‍➡️
                                          </button>
                                        </div>
                                        {isDominatorExpanded && (
                                          <div style={{ display: 'flex', gap: 14, marginTop: '10px' }}>
                                            {/* Left: margins - styled like the right "dominator's own scores" panel */}
                                            <div
                                              style={{
                                                minWidth: 260,
                                                paddingLeft: 0,
                                                borderLeft: 'none',
                                                fontSize: 12,
                                                color: theme === 'dark' ? '#f1f5f9' : '#0b1220',
                                              }}
                                            >
                                              <div style={{ fontWeight: 800, color: theme === 'dark' ? '#cbd5e1' : '#0f3550', marginBottom: 6 }}>
                                                Difference score:
                                              </div>
                                              {Object.entries(dominator.margins).map(([env, margin]) => {
                                                const dominatorScore = dominator.scores?.[env] ?? 0;
                                                const targetEpsilon = model.epsilonThresholds[env] ?? 0;
                                                const difference = dominatorScore - targetEpsilon;
                                                const showDifference = difference >= 0 && Number.isFinite(difference);

                                                return (
                                                  <div key={env} style={{ marginBottom: 2 }}>
                                                    {env}:{' '}
                                                    <span style={{ fontVariantNumeric: 'tabular-nums', color: theme === 'dark' ? '#f1f5f9' : '#0b1220' }}>
                                                      +{formatScore(margin)}
                                                    </span>
                                                    {showDifference && (
                                                      <span
                                                        style={{
                                                          marginLeft: 6,
                                                          color: theme === 'dark' ? '#4ade80' : '#16a34a',
                                                          fontWeight: 700
                                                        }}
                                                      >
                                                        (+{formatScore(difference)})
                                                      </span>
                                                    )}
                                                  </div>
                                                );
                                              })}
                                            </div>

                                            {/* Right: dominator's own scores (full info) */}
                                            <div
                                              style={{
                                                flex: 1,
                                                paddingLeft: 12,
                                                borderLeft: theme === 'dark'
                                                  ? '1px solid rgba(148, 163, 184, 0.2)'
                                                  : '1px solid rgba(148, 163, 184, 0.25)',
                                                fontSize: 12,
                                                color: theme === 'dark' ? '#f1f5f9' : '#0b1220'
                                              }}
                                            >
                                              <div style={{ fontWeight: 800, color: theme === 'dark' ? '#cbd5e1' : '#0f3550', marginBottom: 6 }}>
                                                Dominator scores
                                              </div>
                                              {scoreNames.map((env) => (
                                                <div key={env} style={{ marginBottom: 2 }}>
                                                  {env}:{' '}
                                                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                                                    {formatScore(dominator.scores?.[env] ?? 0)}
                                                  </span>
                                                  {dominator.epsilonThresholds?.[env] !== undefined && (
                                                    <span style={{ color: theme === 'dark' ? '#94a3b8' : '#64748b' }}>
                                                      {' '}[{formatScore(dominator.epsilonThresholds[env] ?? 0)}]
                                                    </span>
                                                  )}
                                                  {dominator.sampleCounts?.[env] !== undefined && (
                                                    <span style={{ color: theme === 'dark' ? '#94a3b8' : '#64748b' }}>
                                                      {' '} / {dominator.sampleCounts[env]}
                                                    </span>
                                                  )}
                                                  {dominator.incompleteProblems?.includes(env) && (
                                                    <span style={{ marginLeft: 6, color: theme === 'dark' ? '#f87171' : '#ef4444', fontWeight: 900 }}>!</span>
                                                  )}
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </>
                              )}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '12px', borderBottom: '1px solid rgba(226, 232, 240, 0.9)' }}>
                          <div
                            onClick={() => toggleScoreExpand(model.uid)}
                            style={{
                              cursor: 'pointer',
                              color: theme === 'dark' ? '#60a5fa' : '#0369a1',
                              fontWeight: 900,
                              marginBottom: '6px'
                            }}
                            title="Click to toggle detailed scores"
                          >
                            {isScoreExpanded ? '▼' : '▶'} Avg: {formatScore(avgScore)}
                          </div>
                          {isScoreExpanded && (
                            <div style={{ fontSize: '12px', color: theme === 'dark' ? '#f1f5f9' : '#0b1220' }}>
                              {scoreNames.map((env) => (
                                <div key={env} style={{ marginBottom: '2px' }}>
                                  {env}: {formatScore(model.scores[env] || 0)}
                                  {model.epsilonThresholds[env] !== undefined && (
                                    <span style={{ color: theme === 'dark' ? '#94a3b8' : '#666' }}>
                                      {' '}[{formatScore(model.epsilonThresholds[env])}]
                                    </span>
                                  )}
                                  {model.sampleCounts?.[env] !== undefined && (
                                    <span style={{ color: theme === 'dark' ? '#94a3b8' : '#64748b' }}>
                                      {' '}/ {model.sampleCounts[env]}
                                    </span>
                                  )}
                                  {model.incompleteProblems?.includes(env) && (
                                    <span style={{ marginLeft: 6, color: theme === 'dark' ? '#f87171' : '#ef4444', fontWeight: 900 }}>!</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                        {scoreNames.map((env) => {
                          const envScore = model.scores[env] ?? 0;
                          const epsilon = model.epsilonThresholds[env];
                          const sampleCount = model.sampleCounts?.[env];
                          const isIncomplete = model.incompleteProblems?.includes(env);
                          return (
                            <td 
                              key={env}
                              style={{ 
                                padding: '12px', 
                                borderBottom: theme === 'dark' 
                                  ? '1px solid rgba(51, 65, 85, 0.5)' 
                                  : '1px solid rgba(226, 232, 240, 0.9)',
                                borderRight: theme === 'dark' 
                                  ? '1px solid rgba(51, 65, 85, 0.5)' 
                                  : '1px solid rgba(226, 232, 240, 0.9)',
                                textAlign: 'center'
                              }}
                            >
                              <div style={{ 
                                fontWeight: 800, 
                                color: theme === 'dark' ? '#f1f5f9' : '#0b1220',
                                fontVariantNumeric: 'tabular-nums'
                              }}>
                                {formatScore(envScore)}
                              </div>
                              {(epsilon !== undefined || sampleCount !== undefined || isIncomplete) && (
                                <div style={{ 
                                  marginTop: 4, 
                                  fontSize: 11, 
                                  color: theme === 'dark' ? '#94a3b8' : '#64748b',
                                  fontVariantNumeric: 'tabular-nums',
                                  lineHeight: 1.4
                                }}>
                                  {epsilon !== undefined && (
                                    <span>[{formatScore(epsilon)}]</span>
                                  )}
                                  {sampleCount !== undefined && (
                                    <span style={{ marginLeft: epsilon !== undefined ? 4 : 0 }}>
                                      / {sampleCount}
                                    </span>
                                  )}
                                  {isIncomplete && (
                                    <span style={{ marginLeft: 6, color: theme === 'dark' ? '#f87171' : '#ef4444', fontWeight: 900 }}>!</span>
                                  )}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <style jsx global>{`
                .modern-scrollbar {
                  scrollbar-width: thin;
                  scrollbar-color: ${theme === 'dark' ? '#475569 #1e293b' : '#36a3fc #f2f6fa'};
                }
                .modern-scrollbar::-webkit-scrollbar {
                  height: 10px;
                  width: 10px;
                  background: ${theme === 'dark' ? '#1e293b' : '#f2f6fa'};
                  border-radius: 7px;
                }
                .modern-scrollbar::-webkit-scrollbar-thumb {
                  background: ${theme === 'dark' 
                    ? 'linear-gradient(90deg, #475569, #64748b 80%)' 
                    : 'linear-gradient(90deg,#a3d2ff,#36a3fc 80%)'};
                  border-radius: 7px;
                  min-height: 30px;
                  min-width: 30px;
                }
                .modern-scrollbar::-webkit-scrollbar-corner {
                  background: ${theme === 'dark' ? '#1e293b' : '#f2f6fa'};
                }
              `}</style>
            </div>
          </div>
        )}

        {data && (
          <StatsPanel data={data} />  
        )}
      </main>
    </>
  );
}
function StatsPanel({ data }: { data: RankData }) {
  const [showStats, setShowStats] = useState(false);

  const isMyModel = (modelName: string) => {
    const prefixes = data?.myModelPrefixes ?? [];
    if (!prefixes.length) return false;
    const lower = modelName.toLowerCase();
    return prefixes.some((p) => {
      const pref = p.toLowerCase();
      return lower.startsWith(pref) || lower.startsWith(pref + '/');
    });
  };

  const isTeamModel = (modelName: string) => {
    const prefixes = data?.teamModelPrefixes ?? [];
    if (!prefixes || !Array.isArray(prefixes) || prefixes.length === 0) {
      return false;
    }
    const lower = modelName.toLowerCase();
    return prefixes.some((p) => {
      if (!p || typeof p !== 'string') return false;
      const pref = p.toLowerCase().trim();
      if (!pref) return false;
      return lower.startsWith(pref) || lower.startsWith(pref + '/');
    });
  };

  const { theme } = useTheme();
  
  return (
    <div style={{ 
      marginTop: '20px', 
      padding: '10px', 
      backgroundColor: theme === 'dark' ? 'rgba(30, 41, 59, 0.8)' : '#f5f5f5', 
      borderRadius: '5px', 
      fontSize: '14px',
      color: theme === 'dark' ? '#f1f5f9' : '#0b1220',
      border: theme === 'dark' ? '1px solid rgba(148, 163, 184, 0.2)' : 'none'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }} onClick={() => setShowStats(s => !s)}>
        <strong>Statistics</strong>
        <span style={{ marginLeft: 8, fontSize: 17 }}>{showStats ? '▼' : '►'}</span>
      </div>
      {showStats && (
        <ul style={{ margin: '10px 0', paddingLeft: '20px' }}>
          <li>Total models: {data.models.length}</li>
          <li>Dominated models: {data.models.filter(m => m.dominance.isDominated).length}</li>
          <li>Undominated models: {data.models.filter(m => !m.dominance.isDominated).length}</li>
          <li>Models with weight: {data.models.filter(m => m.weight > 0).length}</li>
          <li>Group models: {data.models.filter(m => isMyModel(m.modelName)).length}</li>
          <li>Team models: {data.models.filter(m => isTeamModel(m.modelName)).length}</li>
        </ul>
      )}
    </div>
  );
}