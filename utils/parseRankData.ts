interface ModelData {
  uid: number;
  modelName: string;
  firstBlk: number;
  scores: Record<string, number>;
  epsilonThresholds: Record<string, number>;
  sampleCounts: Record<string, number>; // number of problems/samples attempted in that set
  incompleteProblems: Set<string>; // Track which problem sets have "!" (incomplete)
  points: number;
  weight: number;
  eligible: string;
  line: string;
}

interface DominanceInfo {
  isDominated: boolean;
  dominators: Array<{
    uid: number;
    modelName: string;
    margins: Record<string, number>;
    // snapshot of dominator's own scoring info
    scores: Record<string, number>;
    epsilonThresholds: Record<string, number>;
    sampleCounts: Record<string, number>;
    incompleteProblems: string[];
  }>;
}

type ParsedRankData = {
  models: ModelData[];
  scoreOrder: string[];
  currentBlock?: number;
};

function normalizeHeaderName(name: string): string {
  return name.trim();
}

function parseScoreCell(cell: string): { score: number; epsilon: number; samples: number; incomplete: boolean } | null {
  // Format: score[epsilon]/samples or score[epsilon]/samples!
  const m = cell.match(/([\d.]+)\[([\d.]+)\]\/(\d+)(!?)/);
  if (!m) return null;
  return {
    score: parseFloat(m[1]),
    epsilon: parseFloat(m[2]),
    samples: parseInt(m[3]),
    incomplete: m[4] === '!',
  };
}

function findHeaderLine(lines: string[]): string | null {
  // Header always starts with "Hotkey" and contains pipe separators
  for (const line of lines) {
    if (line.includes('|') && line.trim().startsWith('Hotkey')) return line;
  }
  return null;
}

function findCurrentBlock(lines: string[]): number | undefined {
  for (const line of lines) {
    const m = line.match(/MINER RANKING TABLE\s*-\s*Block\s+(\d+)/i);
    if (m) {
      const n = parseInt(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

export function parseRankData(content: string): ParsedRankData {
  const lines = content.split('\n');
  const models: ModelData[] = [];
  const currentBlock = findCurrentBlock(lines);

  const headerLine = findHeaderLine(lines);
  const headerParts = headerLine ? headerLine.split('|').map(p => p.trim()) : [];

  // Identify core columns by name (robust against column additions/removals)
  const idxUID = headerParts.findIndex(p => p.toLowerCase() === 'uid');
  const idxModel = headerParts.findIndex(p => p.toLowerCase() === 'model');
  const idxFirstBlk = headerParts.findIndex(p => p.toLowerCase().includes('firstblk'));
  const idxTotal = headerParts.findIndex(p => p.toLowerCase() === 'total');
  const idxWeight = headerParts.findIndex(p => p.toLowerCase() === 'weight');
  const idxV = headerParts.findIndex(p => p.toLowerCase() === 'v');

  // Score columns live between FirstBlk and the first L* column (L5/L6/...)
  const idxFirstL = headerParts.findIndex(p => /^l\d+$/i.test(p));
  const scoreStart = idxFirstBlk >= 0 ? idxFirstBlk + 1 : 4;
  const scoreEndExclusive = idxFirstL >= 0 ? idxFirstL : (idxTotal >= 0 ? idxTotal : headerParts.length);
  const scoreHeaders = headerParts.slice(scoreStart, scoreEndExclusive).map(normalizeHeaderName);
  const scoreOrder = scoreHeaders;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('=') || line.startsWith('Statistics:') || line.startsWith('Total') || line.startsWith('Active')) continue;
    if (line.trim().startsWith('Hotkey')) continue;
    if (!line.includes('|')) continue;

    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 6) continue;

    try {
      const uidStr = idxUID >= 0 ? parts[idxUID] : parts[1];
      const uid = parseInt(uidStr);
      if (!Number.isFinite(uid)) continue;

      const modelName = idxModel >= 0 ? parts[idxModel] : parts[2];
      const firstBlkStr = idxFirstBlk >= 0 ? parts[idxFirstBlk] : parts[3];
      const firstBlk = firstBlkStr && /^\d+$/.test(firstBlkStr) ? parseInt(firstBlkStr) : 0;

      const scores: Record<string, number> = {};
      const epsilonThresholds: Record<string, number> = {};
      const sampleCounts: Record<string, number> = {};
      const incompleteProblems = new Set<string>();

      // Parse score cells by header order
      let parsedScoreCount = 0;
      for (let i = 0; i < scoreOrder.length; i++) {
        const colIdx = scoreStart + i;
        if (colIdx >= parts.length) continue;

        const key = scoreOrder[i];
        const parsed = parseScoreCell(parts[colIdx]);
        if (!parsed) continue;

        scores[key] = parsed.score;
        epsilonThresholds[key] = parsed.epsilon;
        sampleCounts[key] = parsed.samples;
        parsedScoreCount++;
        if (parsed.incomplete) incompleteProblems.add(key);
      }

      // If we couldn't parse any scores, ignore line
      if (parsedScoreCount === 0) continue;

      const points = idxTotal >= 0 && idxTotal < parts.length ? parseFloat(parts[idxTotal]) || 0 : 0;
      const weight = idxWeight >= 0 && idxWeight < parts.length ? parseFloat(parts[idxWeight]) || 0 : 0;
      const eligible = idxV >= 0 && idxV < parts.length ? (parts[idxV] || 'N') : 'N';

      models.push({
        uid,
        modelName,
        firstBlk,
        scores,
        epsilonThresholds,
        sampleCounts,
        incompleteProblems,
        points,
        weight,
        eligible,
        line: line.trim(),
      });
    } catch {
      continue;
    }
  }

  return { models, scoreOrder, currentBlock };
}

const EPS = 1e-9;

// Helper function to check if `dominator` directly dominates `target`
//
// Dominance Rule (based on stage2_pareto.py _compare_miners function):
// - First determine winner in each environment using threshold
// - A dominates B only if A wins in ALL environments
// - B dominates A only if B wins in ALL environments
// - Otherwise they are non-dominated
//
// Winner Determination:
// - If A came first (lower first_block): B wins if B_score > threshold(A), else A wins
// - If B came first (lower first_block): A wins if A_score > threshold(B), else B wins
//
// Implementation notes:
// - minerA = the one that came first (earlier, lower firstBlk)
// - minerB = the one that came later (higher firstBlk)
// - Only environments where BOTH miners have valid data are considered
// - If no environments can be compared, dominance is false
function directlyDominates(
  dominator: ModelData,
  target: ModelData,
  envs: string[]
): { dominates: boolean; margins: Record<string, number> } {
  // Sanity: cannot dominate itself
  if (dominator.uid === target.uid) return { dominates: false, margins: {} };

  const margins: Record<string, number> = {};
  if (!Array.isArray(envs) || envs.length === 0) return { dominates: false, margins: {} };

  // Must have usable FirstBlk to establish earlier/later
  if (
    !Number.isFinite(dominator.firstBlk) ||
    !Number.isFinite(target.firstBlk) ||
    dominator.firstBlk <= 0 ||
    target.firstBlk <= 0
  ) {
    return { dominates: false, margins: {} };
  }

  if (dominator.firstBlk === target.firstBlk) {
    // If two miners have the same first block, they are non-dominating
    return { dominates: false, margins: {} };
  }

  // Determine which miner came first (earlier = lower firstBlk)
  // minerA = the one that came first (earlier, lower firstBlk)
  // minerB = the one that came later (higher firstBlk)
  // This matches stage2_pareto.py lines 160-161
  const minerA = dominator.firstBlk < target.firstBlk ? dominator : target;
  const minerB = minerA.uid === dominator.uid ? target : dominator;

  // Track which environments we successfully compared
  const comparedEnvs: string[] = [];
  let dominatorWinsCount = 0;

  const EPS = 1e-9; // Epsilon for floating point comparison (matches stage2_pareto.py line 184)

  for (const env of envs) {
    const scoreA = minerA.scores?.[env];
    const scoreB = minerB.scores?.[env];
    const thresholdA = minerA.epsilonThresholds?.[env];
    const samplesA = minerA.sampleCounts?.[env];
    const samplesB = minerB.sampleCounts?.[env];

    // Must have valid, comparable data in this environment for BOTH miners
    if (
      typeof scoreA !== 'number' ||
      typeof scoreB !== 'number' ||
      typeof thresholdA !== 'number' ||
      typeof samplesA !== 'number' ||
      typeof samplesB !== 'number' ||
      samplesA <= 0 ||
      samplesB <= 0 ||
      !Number.isFinite(scoreA) ||
      !Number.isFinite(scoreB) ||
      !Number.isFinite(thresholdA)
    ) {
      // Skip this environment - cannot compare
      continue;
    }

    // Winner determination: A came first, so B wins if B_score > threshold(A) + EPS, else A wins
    // This matches stage2_pareto.py line 185
    const bWins = scoreB > (thresholdA + EPS);
    const winner = bWins ? minerB : minerA;

    // Track if dominator won this environment
    if (winner.uid === dominator.uid) {
      dominatorWinsCount++;
      // Calculate margin: how far the winner cleared the threshold
      // If B wins: margin = B_score - threshold(A)
      // If A wins: margin = threshold(A) - B_score (how much A's threshold exceeds B's score)
      margins[env] = bWins ? (scoreB - thresholdA) : (thresholdA - scoreB);
    } else {
      // Dominator did not win this environment, so cannot dominate
      return { dominates: false, margins: {} };
    }

    comparedEnvs.push(env);
  }

  // Dominator must win in ALL comparable environments
  // If no environments could be compared, cannot determine dominance
  if (comparedEnvs.length === 0) {
    return { dominates: false, margins: {} };
  }

  // Dominator won all comparable environments (matches stage2_pareto.py line 203)
  const dominates = dominatorWinsCount === comparedEnvs.length;
  return { dominates, margins };
}

export function calculateDominance(models: ModelData[], envs?: string[]): Map<number, DominanceInfo> {
  const dominanceMap = new Map<number, DominanceInfo>();

  // IMPORTANT: "Dominator" means DIRECT dominator under the rule.
  // We do NOT include transitive/chain dominators here because that can show models
  // that don't actually clear the target's thresholds (your UID 87 example).
  const resolvedEnvs =
    Array.isArray(envs) && envs.length > 0
      ? envs
      : (() => {
          // Build a stable env list from the first model with any keys.
          for (const m of models) {
            const keys = Object.keys(m.scores ?? {});
            if (keys.length > 0) return keys;
          }
          return [];
        })();

  for (const target of models) {
    const dominators: DominanceInfo['dominators'] = [];

    for (const other of models) {
      if (other.uid === target.uid) continue;

      const result = directlyDominates(other, target, resolvedEnvs);
      if (!result.dominates) continue;

      dominators.push({
        uid: other.uid,
        modelName: other.modelName,
        margins: result.margins,
        scores: other.scores ?? {},
        epsilonThresholds: other.epsilonThresholds ?? {},
        sampleCounts: other.sampleCounts ?? {},
        incompleteProblems: Array.from(other.incompleteProblems ?? []),
      });
    }

    dominanceMap.set(target.uid, {
      isDominated: dominators.length > 0,
      dominators,
    });
  }

  return dominanceMap;
}
