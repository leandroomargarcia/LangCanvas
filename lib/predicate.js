// Shared state-predicate helpers for conditionals (routers).

export const PRED_OPS = [
  ['empty', 'is empty'],
  ['not_empty', 'is not empty'],
  ['truthy', 'is truthy'],
  ['>=', '>='],
  ['<=', '<='],
  ['>', '>'],
  ['<', '<'],
  ['==', '=='],
  ['!=', '!='],
];

export function isUnaryOp(op) {
  return op === 'empty' || op === 'not_empty' || op === 'truthy';
}

function asInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function isEmptyValue(v) {
  if (v == null) return true;
  if (v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '[]' || s === '{}';
  }
  return false;
}

export function normalizeClause(c) {
  const src = c && typeof c === 'object' ? c : {};
  return {
    left: String(src.left || '').trim(),
    op: src.op || 'empty',
    rightMode: src.rightMode === 'literal' ? 'literal' : 'key',
    right: src.right != null ? String(src.right) : '',
  };
}

export function predicateClauses(d) {
  if (!d) return [];
  const first = normalizeClause({
    left: d.predLeft,
    op: d.predOp,
    rightMode: d.predRightMode,
    right: d.predRight,
  });
  const extra = Array.isArray(d.predExtra) ? d.predExtra.map(normalizeClause) : [];
  return [first].concat(extra);
}

export function filledClauses(d) {
  return predicateClauses(d).filter(c => c.left);
}

export function predicateJoin(d) {
  return d && d.predJoin === 'or' ? 'or' : 'and';
}

export function formatClause(c) {
  if (!c || !c.left) return '';
  if (c.op === 'truthy') return c.left;
  if (c.op === 'empty') return c.left + ' is empty';
  if (c.op === 'not_empty') return c.left + ' is not empty';
  const op = c.op || '>=';
  const right = c.rightMode === 'literal'
    ? JSON.stringify(c.right || '')
    : (c.right || '');
  return (c.left + ' ' + op + ' ' + right).trim();
}

export function formatPredicate(d) {
  const clauses = filledClauses(d);
  if (!clauses.length) return d && d.condition ? d.condition : '';
  const join = predicateJoin(d);
  return clauses.map(formatClause).join(join === 'or' ? ' or ' : ' and ');
}

export function evalClause(state, c) {
  if (!c || !c.left) return false;
  const leftRaw = state ? state[c.left] : undefined;
  const op = c.op || '>=';
  if (op === 'empty') return isEmptyValue(leftRaw);
  if (op === 'not_empty') return !isEmptyValue(leftRaw);
  if (op === 'truthy') {
    return !!leftRaw && leftRaw !== 'false' && !isEmptyValue(leftRaw);
  }
  const rightRaw = c.rightMode === 'literal'
    ? c.right
    : (state ? state[c.right] : undefined);
  const left = asInt(leftRaw, Number(leftRaw) || 0);
  const right = asInt(rightRaw, Number(rightRaw) || 0);
  if (op === '>=') return left >= right;
  if (op === '<=') return left <= right;
  if (op === '>') return left > right;
  if (op === '<') return left < right;
  if (op === '==') return String(leftRaw) === String(rightRaw);
  if (op === '!=') return String(leftRaw) !== String(rightRaw);
  return false;
}

export function evalPredicate(state, d) {
  const clauses = filledClauses(d);
  if (!clauses.length) return false;
  if (predicateJoin(d) === 'or') return clauses.some(c => evalClause(state, c));
  return clauses.every(c => evalClause(state, c));
}

function pyGet(key) {
  return 'state.get("' + String(key || '').replace(/"/g, '\\"') + '")';
}

function pyLiteral(raw) {
  const n = Number(raw);
  if (raw !== '' && Number.isFinite(n) && String(raw).trim() === String(n)) return String(n);
  return JSON.stringify(raw == null ? '' : String(raw));
}

export function pythonClause(c) {
  if (!c || !c.left) return 'False';
  const left = pyGet(c.left);
  if (c.op === 'empty') return 'not ' + left;
  if (c.op === 'not_empty') return 'bool(' + left + ')';
  if (c.op === 'truthy') return 'bool(' + left + ')';
  const right = c.rightMode === 'literal' ? pyLiteral(c.right) : pyGet(c.right);
  return left + ' ' + (c.op || '>=') + ' ' + right;
}

export function pythonPredicate(d) {
  const clauses = filledClauses(d);
  if (!clauses.length) return 'False';
  const join = predicateJoin(d) === 'or' ? ' or ' : ' and ';
  const parts = clauses.map(c => {
    const expr = pythonClause(c);
    return clauses.length > 1 ? '(' + expr + ')' : expr;
  });
  return parts.join(join);
}

export function missingWaitKeys(state, keys) {
  return (keys || []).map(k => String(k || '').trim()).filter(k => k && isEmptyValue(state ? state[k] : undefined));
}

export function predicateReadKeys(d) {
  const keys = [];
  filledClauses(d).forEach(c => {
    if (c.left) keys.push(c.left);
    if (!isUnaryOp(c.op) && c.rightMode !== 'literal' && c.right) keys.push(c.right);
  });
  return [...new Set(keys)];
}
