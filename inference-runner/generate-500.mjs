import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const TARGET = 500;
const BATCH_SIZE = 100;
const MIN_WORDS = 8;
const MAX_WORDS = 18;
const REQUEST_INTERVAL_MS = Number(process.env.INFERENCE_DELAY_MS || 20000);
const RUN_ID = `remote-inference-${new Date().toISOString().replace(/[:.]/g, '-')}`;

const TOPICS = [
  'weather, forests, oceans, wildlife, seasons, astronomy, and natural observations',
  'computing, engineering, tools, architecture, transport, energy, and practical invention',
  'food, households, work, markets, education, sport, travel, and daily routines',
  'history, language, books, music, painting, theatre, archives, and cultural memory',
  'friendship, cooperation, curiosity, uncertainty, planning, imagination, and future societies',
];

const PROVIDERS = [
  {
    name: 'blockrun-free-gpt-oss-120b',
    endpoint: 'https://blockrun.ai/api/v1/chat/completions',
    model: 'nvidia/gpt-oss-120b',
    kind: 'openai',
  },
  {
    name: 'ovh-anonymous-qwen3-32b',
    endpoint: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    model: 'Qwen3-32B',
    kind: 'openai',
  },
  {
    name: 'mlvoca-free-deepseek-r1-1.5b',
    endpoint: 'https://mlvoca.com/api/generate',
    model: 'deepseek-r1:1.5b',
    kind: 'ollama',
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

async function fetchWithTimeout(url, options, timeoutMs = 300_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt({ requested, batchIndex, attempt, accepted }) {
  const avoid = accepted.slice(-40);
  return [
    `Generate exactly ${requested} distinct, natural, standalone English sentences.`,
    'Return only valid JSON in this exact shape:',
    '{"sentences":["First complete sentence.","Second complete sentence."]}',
    `Dataset batch ${batchIndex + 1}; attempt ${attempt}; nonce ${RUN_ID}.`,
    `Topic palette: ${TOPICS[batchIndex % TOPICS.length]}.`,
    'Hard constraints:',
    `- Every sentence contains ${MIN_WORDS} to ${MAX_WORDS} words inclusive.`,
    '- Every sentence is grammatical, semantically specific, safe, and terminally punctuated.',
    '- Vary subject, verb, tense, syntax, vocabulary, and length.',
    '- Do not use numbering, labels, quotations, fragments, slogans, or personal information.',
    '- Do not repeat or lightly paraphrase another item.',
    '- Output JSON only, without Markdown, commentary, or reasoning.',
    avoid.length ? `Never repeat these accepted sentences:\n${avoid.map((s) => `- ${s}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

async function invokeProvider(provider, prompt, seed) {
  let body;
  if (provider.kind === 'ollama') {
    body = {
      model: provider.model,
      prompt,
      system: 'Produce synthetic English training data. Follow exact JSON and count constraints.',
      stream: false,
      format: 'json',
      options: { temperature: 0.9, seed, num_predict: 4096 },
    };
  } else {
    body = {
      model: provider.model,
      messages: [
        {
          role: 'system',
          content: 'Produce synthetic English training data. Follow exact JSON and count constraints.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.9,
      seed,
      max_tokens: 4096,
      stream: false,
    };
  }

  const startedAt = new Date().toISOString();
  const response = await fetchWithTimeout(provider.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const rawBody = await response.text();
  const headers = Object.fromEntries(
    [...response.headers.entries()].filter(([key]) =>
      ['content-type', 'x-request-id', 'cf-ray', 'retry-after', 'x-ratelimit-remaining'].includes(key.toLowerCase()),
    ),
  );

  if (!response.ok) {
    const error = new Error(`${provider.name} returned HTTP ${response.status}: ${rawBody.slice(0, 1000)}`);
    error.status = response.status;
    error.rawBody = rawBody;
    error.headers = headers;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }

  const content = provider.kind === 'ollama'
    ? parsed?.response
    : parsed?.choices?.[0]?.message?.content ?? parsed?.choices?.[0]?.text;

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`${provider.name} returned no generated text: ${rawBody.slice(0, 1000)}`);
  }

  return {
    provider: provider.name,
    endpoint: provider.endpoint,
    requestedModel: provider.model,
    reportedModel: parsed?.model || provider.model,
    responseId: parsed?.id || null,
    usage: parsed?.usage || null,
    finishReason: parsed?.choices?.[0]?.finish_reason || null,
    startedAt,
    completedAt: new Date().toISOString(),
    httpStatus: response.status,
    headers,
    rawBody,
    content,
  };
}

async function callRemoteModel(prompt, seed, preferredProviderIndex) {
  const indices = PROVIDERS.map((_, index) => index);
  const order = preferredProviderIndex == null
    ? indices
    : [preferredProviderIndex, ...indices.filter((index) => index !== preferredProviderIndex)];
  const failures = [];

  for (const index of order) {
    const provider = PROVIDERS[index];
    try {
      const response = await invokeProvider(provider, prompt, seed);
      return { ...response, providerIndex: index, failuresBeforeSuccess: failures };
    } catch (error) {
      failures.push({
        provider: provider.name,
        endpoint: provider.endpoint,
        model: provider.model,
        message: String(error?.message ?? error),
        httpStatus: error?.status ?? null,
        headers: error?.headers ?? null,
        rawBodyPreview: String(error?.rawBody ?? '').slice(0, 1000),
      });
    }
  }

  throw new Error(`Every remote inference provider failed: ${JSON.stringify(failures)}`);
}

function extractCandidateArray(content) {
  const text = String(content ?? '').trim();
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(text.slice(objectStart, objectEnd + 1));
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(text.slice(arrayStart, arrayEnd + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.sentences)) return parsed.sentences;
      if (Array.isArray(parsed?.data)) return parsed.data;
    } catch {
      // Try the next representation.
    }
  }

  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

function normalizeSentence(value) {
  let sentence = String(value ?? '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
    .replace(/^['"“”‘’]+|['"“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sentence) return '';
  sentence = sentence[0].toUpperCase() + sentence.slice(1);
  if (!/[.!?]$/.test(sentence)) sentence += '.';
  return sentence;
}

function wordCount(sentence) {
  return sentence
    .replace(/[“”"'‘’()[\]{}.,!?;:—–-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

function validate(values, globallySeen, locallySeen) {
  const accepted = [];
  const rejected = [];
  for (const value of values) {
    const sentence = normalizeSentence(value);
    const key = sentence.toLocaleLowerCase('en-US');
    const words = wordCount(sentence);
    let reason = null;
    if (!sentence) reason = 'empty';
    else if (words < MIN_WORDS || words > MAX_WORDS) reason = `word_count_${words}`;
    else if (globallySeen.has(key) || locallySeen.has(key)) reason = 'duplicate';
    else if (sentence.length > 300) reason = 'too_long';

    if (reason) rejected.push({ sentence, reason });
    else {
      locallySeen.add(key);
      accepted.push(sentence);
    }
  }
  return { accepted, rejected };
}

function summarizeRejections(items) {
  return items.reduce((summary, item) => {
    summary[item.reason] = (summary[item.reason] || 0) + 1;
    return summary;
  }, {});
}

async function main() {
  const startedAt = new Date().toISOString();
  const records = [];
  const calls = [];
  const rawResponses = [];
  const globalSeen = new Set();
  let preferredProviderIndex = null;
  let lastRequestAt = 0;

  for (let batchIndex = 0; records.length < TARGET; batchIndex += 1) {
    const batchTarget = Math.min(BATCH_SIZE, TARGET - records.length);
    const batchSentences = [];
    const batchSeen = new Set();

    for (let attempt = 1; attempt <= 8 && batchSentences.length < batchTarget; attempt += 1) {
      const needed = batchTarget - batchSentences.length;
      const sinceLast = Date.now() - lastRequestAt;
      if (lastRequestAt && sinceLast < REQUEST_INTERVAL_MS) await sleep(REQUEST_INTERVAL_MS - sinceLast);

      const prompt = buildPrompt({
        requested: needed,
        batchIndex,
        attempt,
        accepted: [...records.map((record) => record.sentence), ...batchSentences],
      });
      const seed = 2026080800 + batchIndex * 101 + attempt * 17;
      const callNumber = calls.length + 1;
      lastRequestAt = Date.now();

      let response;
      try {
        response = await callRemoteModel(prompt, seed, preferredProviderIndex);
        preferredProviderIndex = response.providerIndex;
      } catch (error) {
        calls.push({
          call: callNumber,
          batch: batchIndex + 1,
          attempt,
          requested: needed,
          seed,
          completedAt: new Date().toISOString(),
          error: String(error?.message ?? error),
        });
        if (attempt === 8) throw error;
        await sleep(Math.min(120_000, 10_000 * 2 ** (attempt - 1)));
        continue;
      }

      const candidates = extractCandidateArray(response.content);
      const validated = validate(candidates, globalSeen, batchSeen);
      const taken = validated.accepted.slice(0, needed);
      batchSentences.push(...taken);
      const responseHash = sha256(response.rawBody);

      calls.push({
        call: callNumber,
        batch: batchIndex + 1,
        attempt,
        requested: needed,
        seed,
        startedAt: response.startedAt,
        completedAt: response.completedAt,
        provider: response.provider,
        endpoint: response.endpoint,
        requestedModel: response.requestedModel,
        reportedModel: response.reportedModel,
        responseId: response.responseId,
        usage: response.usage,
        finishReason: response.finishReason,
        httpStatus: response.httpStatus,
        responseHeaders: response.headers,
        failuresBeforeSuccess: response.failuresBeforeSuccess,
        responseSha256: responseHash,
        parsedCandidates: candidates.length,
        accepted: taken.length,
        rejected: validated.rejected.length,
        rejectionReasons: summarizeRejections(validated.rejected),
      });
      rawResponses.push({
        call: callNumber,
        provider: response.provider,
        endpoint: response.endpoint,
        requestedModel: response.requestedModel,
        reportedModel: response.reportedModel,
        responseId: response.responseId,
        responseSha256: responseHash,
        rawBody: response.rawBody,
      });

      console.log(
        `Batch ${batchIndex + 1}, attempt ${attempt}: accepted ${taken.length}/${needed}; total pending ${records.length + batchSentences.length}/${TARGET}; provider ${response.provider}`,
      );

      if (batchSentences.length < batchTarget) await sleep(10_000 * attempt);
    }

    if (batchSentences.length !== batchTarget) {
      throw new Error(`Batch ${batchIndex + 1} produced ${batchSentences.length}/${batchTarget} valid sentences.`);
    }

    for (const sentence of batchSentences) {
      const key = sentence.toLocaleLowerCase('en-US');
      globalSeen.add(key);
      const source = calls.findLast((call) => call.batch === batchIndex + 1 && call.provider);
      records.push({
        id: records.length + 1,
        sentence,
        batch: batchIndex + 1,
        provider: source?.provider || 'remote-inference-provider',
        model: source?.reportedModel || source?.requestedModel || null,
      });
    }
  }

  if (records.length !== TARGET || globalSeen.size !== TARGET) {
    throw new Error(`Final validation failed: count=${records.length}, unique=${globalSeen.size}, target=${TARGET}.`);
  }

  const numberedText = records
    .map((record) => `${String(record.id).padStart(3, '0')}. ${record.sentence}`)
    .join('\n') + '\n';
  const jsonArray = records.map((record) => record.sentence);
  const jsonl = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  const rawJsonl = rawResponses.map((response) => JSON.stringify(response)).join('\n') + '\n';
  const observedWordCounts = records.map((record) => wordCount(record.sentence));
  const sentenceHash = sha256(numberedText);

  const manifest = {
    runId: RUN_ID,
    startedAt,
    completedAt: new Date().toISOString(),
    generatorHost: {
      environment: 'GitHub Actions hosted Linux VM',
      repository: process.env.GITHUB_REPOSITORY || null,
      workflow: process.env.GITHUB_WORKFLOW || null,
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      runnerName: process.env.RUNNER_NAME || null,
      runnerOs: process.env.RUNNER_OS || null,
      runnerArch: process.env.RUNNER_ARCH || null,
      commitSha: process.env.GITHUB_SHA || null,
    },
    inference: {
      localModelUsed: false,
      remoteApiUsed: true,
      successfulInferenceCalls: calls.filter((call) => call.httpStatus >= 200 && call.httpStatus < 300).length,
      providersUsed: [...new Set(calls.map((call) => call.provider).filter(Boolean))],
      modelsUsed: [...new Set(calls.map((call) => call.reportedModel || call.requestedModel).filter(Boolean))],
      callLog: calls,
    },
    validation: {
      targetCount: TARGET,
      actualCount: records.length,
      uniqueCount: globalSeen.size,
      requiredWordRange: [MIN_WORDS, MAX_WORDS],
      minimumObservedWords: Math.min(...observedWordCounts),
      maximumObservedWords: Math.max(...observedWordCounts),
      allTerminallyPunctuated: records.every((record) => /[.!?]$/.test(record.sentence)),
    },
    provenance: {
      sentencesSha256: sentenceHash,
      rawInferenceResponsesRecorded: rawResponses.length,
      note: 'Every accepted sentence was parsed from a successful remote model inference HTTP response. No local model or static sentence bank was used.',
    },
  };

  const validationText = [
    `target_count=${TARGET}`,
    `actual_count=${records.length}`,
    `unique_count=${globalSeen.size}`,
    `minimum_observed_words=${manifest.validation.minimumObservedWords}`,
    `maximum_observed_words=${manifest.validation.maximumObservedWords}`,
    `all_terminally_punctuated=${manifest.validation.allTerminallyPunctuated}`,
    `remote_api_used=${manifest.inference.remoteApiUsed}`,
    `local_model_used=${manifest.inference.localModelUsed}`,
    `successful_inference_calls=${manifest.inference.successfulInferenceCalls}`,
    `providers_used=${manifest.inference.providersUsed.join(',')}`,
    `models_used=${manifest.inference.modelsUsed.join(',')}`,
    `sentences_sha256=${sentenceHash}`,
  ].join('\n') + '\n';

  await mkdir('generated', { recursive: true });
  await writeFile('generated/500-sentences.txt', numberedText, 'utf8');
  await writeFile('generated/500-sentences.json', JSON.stringify(jsonArray, null, 2) + '\n', 'utf8');
  await writeFile('generated/500-sentences.jsonl', jsonl, 'utf8');
  await writeFile('generated/raw-inference-responses.jsonl', rawJsonl, 'utf8');
  await writeFile('generated/inference-manifest.json', JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await writeFile('generated/validation.txt', validationText, 'utf8');
  console.log(`Completed ${TARGET} remote-inference sentences. SHA-256: ${sentenceHash}`);
}

main().catch(async (error) => {
  console.error(error?.stack || error);
  await mkdir('generated', { recursive: true });
  await writeFile('generated/FAILED.txt', `${new Date().toISOString()}\n${String(error?.stack || error)}\n`, 'utf8');
  process.exitCode = 1;
});
