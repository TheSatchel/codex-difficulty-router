import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireValue } from './ratings.mjs';

const exec = promisify(execFile);
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const SPEEDS = ['normal', 'fast', 'ultrafast'];
export const PRIORITIES = ['background', 'normal', 'high', 'urgent'];

export async function scanProject(cwd) {
  try {
    // Filename metadata only. Follow neither symlinks nor external checkouts;
    // do not open source files, env files, retired repositories or transcripts.
    const { stdout } = await exec('git', ['-C', cwd, 'ls-files', '-z'], { maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
    const all = stdout.split('\0').filter(Boolean);
    const files = all.slice(0, 10_000);
    return {
      available: true, fileCount: all.length, truncated: all.length > files.length,
      packageCount: files.filter(f => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|[^/]+\.csproj)$/.test(f)).length,
      hasTests: files.some(f => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(f)),
      hasCI: files.some(f => f.startsWith('.github/workflows/'))
    };
  } catch {
    return { available: false, reason: 'Project metadata unavailable; uncertainty remains explicit.' };
  }
}

export function assessTask({ prompt, project = {}, metadata = {} }) {
  requireValue(typeof prompt === 'string' && prompt.trim().length > 0, 'EMPTY_TASK', 'A task prompt is required.');
  const factors = [];
  let difficulty = 1;
  const add = (condition, weight, reason) => { if (condition) { difficulty += weight; factors.push(reason); } };
  add(/架构|architecture|跨模块|cross.module|重构|refactor/i.test(prompt), 1, 'architecture or cross-module change');
  add(/迁移|migration|并发|concurren|一致性|consistency|分布式|distributed/i.test(prompt), 1, 'state, concurrency or migration constraints');
  add(/权限|鉴权|认证|security|auth|支付|payment|生产数据|production data/i.test(prompt), 1, 'sensitive correctness boundary');
  add(/未知|不确定|偶发|intermittent|unknown|无法复现|root.cause/i.test(prompt), 1, 'unresolved cause or requirements');
  if (project.packageCount > 5 && difficulty > 1) { difficulty += 0.5; factors.push('multiple project packages amplify an already complex task'); }
  // Repository size alone never forces a trivial task into a high tier.
  if (/错别字|typo|拼写|spelling|改名一个|rename one/i.test(prompt) && factors.length === 0) difficulty = 0;
  const inferred = difficulty >= 4 ? 'expert' : difficulty >= 3 ? 'complex' : difficulty >= 2 ? 'standard' : 'simple';
  const level = metadata.difficulty ?? inferred;
  requireValue(['simple', 'standard', 'complex', 'expert'].includes(level), 'INVALID_DIFFICULTY', 'Unknown difficulty.');
  let priority = 'normal';
  if (/后台|夜间|离线|不着急|background|overnight|batch|not urgent/i.test(prompt)) priority = 'background';
  else if (/P0\b|线上故障|生产故障|紧急|立刻|立即|urgent|ASAP|production.{0,12}(down|outage)/i.test(prompt)) priority = 'urgent';
  else if (/阻塞|blocking|deadline|演示|live demo|interactive|交互|尽快|优先处理/i.test(prompt)) priority = 'high';
  priority = metadata.priority ?? priority;
  requireValue(PRIORITIES.includes(priority), 'INVALID_PRIORITY', 'Unknown task priority.');
  const requestedSpeed = metadata.speed ?? ({ background: 'normal', normal: 'normal', high: 'fast', urgent: 'ultrafast' })[priority];
  requireValue(SPEEDS.includes(requestedSpeed), 'INVALID_SPEED', 'Speed must be normal, fast or ultrafast.');
  const floors = { simple: 'low', standard: 'medium', complex: 'high', expert: 'xhigh' };
  return {
    difficulty: level, minimumEffort: floors[level], priority, requestedSpeed, tokens: metadata.tokens,
    uncertainty: !project.available || /未知|不确定|unknown|unclear/i.test(prompt) ? 'high' : 'medium',
    factors, project,
    boundsMeaning: 'Effort floor and candidate score range are routing estimates, not a proof of project solvability.',
    decomposition: 'Extract independently verifiable tasks with explicit inputs, outputs, dependencies and write scopes; keep coupled work together.'
  };
}
