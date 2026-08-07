import { readFile, writeFile } from 'node:fs/promises';

const sourceUrl = new URL('./generate-500.mjs', import.meta.url);
let source = await readFile(sourceUrl, 'utf8');

source = source
  .replace('const BATCH_SIZE = 100;', 'const BATCH_SIZE = 25;')
  .replace('const MIN_WORDS = 8;', 'const MIN_WORDS = 3;')
  .replace('const MAX_WORDS = 18;', 'const MAX_WORDS = 60;')
  .replace(/const REQUEST_INTERVAL_MS = .*?;/, 'const REQUEST_INTERVAL_MS = 4000;');

source = source.replace(
  /const PROVIDERS = \[[\s\S]*?\n\];\n\nconst sleep/,
  `const PROVIDERS = [
  {
    name: 'blockrun-free-qwen3-next-80b',
    endpoint: 'https://blockrun.ai/api/v1/chat/completions',
    model: 'nvidia/qwen3-next-80b-a3b-instruct',
    kind: 'openai',
  },
  {
    name: 'blockrun-free-gpt-oss-20b',
    endpoint: 'https://blockrun.ai/api/v1/chat/completions',
    model: 'nvidia/gpt-oss-20b',
    kind: 'openai',
  },
];

const sleep`,
);

const buildPromptSource = [
  'function buildPrompt({ requested, batchIndex, attempt, accepted }) {',
  '  const avoid = accepted.slice(-40);',
  '  return [',
  '    `Write exactly ${requested} distinct, natural, standalone English sentences.`,',
  "    'Put exactly one complete sentence on each line.',",
  "    'Do not use numbering, bullets, labels, JSON, Markdown, or commentary.',",
  '    `Dataset batch ${batchIndex + 1}; attempt ${attempt}; nonce ${RUN_ID}.`,',
  '    `Topic palette: ${TOPICS[batchIndex % TOPICS.length]}.`,',
  "    'Vary subject, verb, tense, syntax, vocabulary, and sentence length.',",
  "    'Every line must be grammatical, semantically specific, safe, and terminally punctuated.',",
  "    'Do not repeat or lightly paraphrase another sentence.',",
  "    avoid.length ? `Never repeat these accepted sentences:\\n${avoid.map((s) => `- ${s}`).join('\\n')}` : '',",
  "  ].filter(Boolean).join('\\n');",
  '}',
].join('\n');

source = source.replace(
  /function buildPrompt\([\s\S]*?\n\}\n\nasync function invokeProvider/,
  `${buildPromptSource}\n\nasync function invokeProvider`,
);

const extractSource = [
  'function extractCandidateArray(content) {',
  "  let text = String(content ?? '').replace(/<think>[\\s\\S]*?<\\/think>/gi, '').trim();",
  '  if (!text) return [];',
  '  const candidates = [text];',
  "  const fenced = text.match(/```(?:json|text)?\\s*([\\s\\S]*?)```/i);",
  '  if (fenced) candidates.unshift(fenced[1].trim());',
  "  const objectStart = text.indexOf('{');",
  "  const objectEnd = text.lastIndexOf('}');",
  '  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(text.slice(objectStart, objectEnd + 1));',
  "  const arrayStart = text.indexOf('[');",
  "  const arrayEnd = text.lastIndexOf(']');",
  '  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(text.slice(arrayStart, arrayEnd + 1));',
  '  for (const candidate of candidates) {',
  '    try {',
  '      const parsed = JSON.parse(candidate);',
  '      if (Array.isArray(parsed)) return parsed;',
  '      if (Array.isArray(parsed?.sentences)) return parsed.sentences;',
  '      if (Array.isArray(parsed?.data)) return parsed.data;',
  '    } catch {}',
  '  }',
  "  const partialArray = text.match(/[\\\"']?sentences[\\\"']?\\s*:\\s*\\[([\\s\\S]*)/i);",
  '  if (partialArray) {',
  '    const recovered = [];',
  '    const quoted = partialArray[1].match(/"(?:\\\\.|[^"\\\\])*"/g) || [];',
  '    for (const token of quoted) {',
  '      try { recovered.push(JSON.parse(token)); } catch {}',
  '    }',
  '    if (recovered.length) return recovered;',
  '  }',
  '  const cleanedLines = text',
  "    .replace(/^```.*$/gm, '')",
  "    .replace(/^\\s*[\\[{]?\\s*[\\\"']?sentences[\\\"']?\\s*:\\s*\\[?\\s*/i, '')",
  "    .replace(/\\s*[\\]}],?\\s*$/, '')",
  "    .split(/\\r?\\n/)",
  "    .map((line) => line.replace(/^\\s*(?:[-*•]|\\d+[.)])\\s*/, '').replace(/^['\\\"“”‘’]+|['\\\"“”‘’]+[,]?$/g, '').trim())",
  '    .filter(Boolean);',
  '  if (cleanedLines.length > 1) return cleanedLines;',
  '  return text',
  "    .replace(/\\s+/g, ' ')",
  "    .split(/(?<=[.!?])\\s+(?=[A-Z])/)",
  "    .map((item) => item.replace(/^\\s*(?:[-*•]|\\d+[.)])\\s*/, '').trim())",
  '    .filter(Boolean);',
  '}',
].join('\n');

source = source.replace(
  /function extractCandidateArray\([\s\S]*?\n\}\n\nfunction normalizeSentence/,
  `${extractSource}\n\nfunction normalizeSentence`,
);

source = source
  .replace(
    'async function fetchWithTimeout(url, options, timeoutMs = 300_000)',
    'async function fetchWithTimeout(url, options, timeoutMs = 75_000)',
  )
  .replace(
    '      temperature: 0.9,\n      seed,\n      max_tokens: 4096,',
    '      temperature: 0.9,\n      max_tokens: 4096,',
  )
  .replace(
    'for (let attempt = 1; attempt <= 8 && batchSentences.length < batchTarget; attempt += 1)',
    'for (let attempt = 1; attempt <= 8 && batchSentences.length < batchTarget; attempt += 1)',
  );

const runtimePath = `/tmp/generate-500-fast-${process.pid}.mjs`;
await writeFile(runtimePath, source, 'utf8');
await import(`file://${runtimePath}?run=${Date.now()}`);
