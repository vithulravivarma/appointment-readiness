const ASK_TARGET_STOPWORDS = new Set([
  'about',
  'if',
  'whether',
  'what',
  'when',
  'where',
  'why',
  'how',
  'which',
  'who',
  'whom',
  'me',
  'us',
  'you',
  'my',
  'our',
  'the',
  'a',
  'an',
  'this',
  'that',
  'it',
  'details',
  'detail',
  'info',
  'information',
  'update',
  'updates',
  'question',
  'questions',
]);

function normalizeText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAskNamedPersonIntent(normalized: string): boolean {
  const match = normalized.match(/\bask\s+([a-z][a-z'-]{1,})\s+(about|if|whether|for|to confirm)\b/);
  if (!match) return false;
  const target = String(match[1] || '').trim();
  if (!target || ASK_TARGET_STOPWORDS.has(target)) return false;
  return true;
}

function hasReachOutNamedPersonIntent(normalized: string): boolean {
  const patterns = [
    /\breach out to\s+([a-z][a-z'-]{1,})\b/,
    /\b(?:contact|message|text|ping)\s+([a-z][a-z'-]{1,})\b/,
    /\b(?:check with|follow up with)\s+([a-z][a-z'-]{1,})\b/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const target = String(match[1] || '').trim();
    if (!target || ASK_TARGET_STOPWORDS.has(target)) continue;
    return true;
  }
  return false;
}

function hasNamedPersonReference(normalized: string): boolean {
  if (/\b[a-z][a-z'-]{1,}'s\b/.test(normalized)) {
    return true;
  }

  const patterns = [
    /\b(?:does|did|is|has|have|ask|contact|message|text|reach out to|check with|follow up with)\s+([a-z][a-z'-]{1,})\b/,
    /\bfor\s+([a-z][a-z'-]{1,})\b/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const target = String(match[1] || '').trim();
    if (!target || ASK_TARGET_STOPWORDS.has(target)) continue;
    return true;
  }
  return false;
}

function hasFindOutDirective(normalized: string): boolean {
  return (
    /\bfind out\b/.test(normalized) ||
    /\bif you do not know\b/.test(normalized) ||
    /\bif you don't know\b/.test(normalized) ||
    /\bcan you verify\b/.test(normalized) ||
    /\bcan you confirm\b/.test(normalized) ||
    /\bcheck for me\b/.test(normalized)
  );
}

function hasPersonReference(normalized: string): boolean {
  return /\b(client|family|parent|guardian|patient|him|her|them)\b/.test(normalized) || hasNamedPersonReference(normalized);
}

function hasExplicitOutreachDirective(normalized: string): boolean {
  const outreachVerb = /\b(ask|reach out|contact|message|text|ping|check with|follow up with|delegate)\b/.test(normalized);
  if (!outreachVerb) return false;
  if (/\b(can|could|would|will)\s+you\b/.test(normalized)) return true;
  if (/\bplease\b/.test(normalized)) return true;
  return /^(ask|reach out|contact|message|text|ping|check with|follow up with|delegate)\b/.test(normalized);
}

export function hasExplicitDelegationDirective(command: string): boolean {
  const normalized = normalizeText(command);
  if (!normalized) return false;

  if (hasExplicitOutreachDirective(normalized) && hasPersonReference(normalized)) {
    return true;
  }

  if (hasFindOutDirective(normalized) && hasPersonReference(normalized)) {
    return true;
  }

  return false;
}

export function hasDelegationIntent(command: string): boolean {
  const normalized = normalizeText(command);
  if (!normalized) return false;

  if (/\b(delegate|delegation)\b/.test(normalized)) {
    return true;
  }

  if (/\b(reach out|contact|message|text|ping|check with|follow up with)\b/.test(normalized)) {
    if (/\b(client|family|parent|guardian|patient|him|her|them)\b/.test(normalized)) {
      return true;
    }
  }

  if (/\bask\s+(?:the\s+)?(?:client|family|parent|guardian|patient|him|her|them)\b/.test(normalized)) {
    return true;
  }

  if (hasFindOutDirective(normalized) && hasPersonReference(normalized)) {
    return true;
  }

  return hasAskNamedPersonIntent(normalized) || hasReachOutNamedPersonIntent(normalized);
}
