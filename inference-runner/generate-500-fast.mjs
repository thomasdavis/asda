import { readFile, writeFile } from 'node:fs/promises';

const sourceUrl = new URL('./generate-500.mjs', import.meta.url);
let source = await readFile(sourceUrl, 'utf8');

source = source.replace(
  /const REQUEST_INTERVAL_MS = .*?;/,
  'const REQUEST_INTERVAL_MS = 5000;',
);

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

source = source
  .replace(
    'async function fetchWithTimeout(url, options, timeoutMs = 300_000)',
    'async function fetchWithTimeout(url, options, timeoutMs = 90_000)',
  )
  .replace(
    '      temperature: 0.9,\n      seed,\n      max_tokens: 4096,',
    '      temperature: 0.8,\n      max_tokens: 4096,',
  )
  .replace(
    'for (let attempt = 1; attempt <= 8 && batchSentences.length < batchTarget; attempt += 1)',
    'for (let attempt = 1; attempt <= 6 && batchSentences.length < batchTarget; attempt += 1)',
  )
  .replace('if (attempt === 8) throw error;', 'if (attempt === 6) throw error;');

const runtimePath = `/tmp/generate-500-fast-${process.pid}.mjs`;
await writeFile(runtimePath, source, 'utf8');
await import(`file://${runtimePath}?run=${Date.now()}`);
