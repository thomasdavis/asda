import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const TARGET = 500;
const BATCH_SIZE = 100;
const MODEL = process.env.INFERENCE_MODEL || 'openai';
const MIN_WORDS = 8;
const MAX_WORDS = 18;
const INTER_REQUEST_DELAY_MS = Number(process.env.INFERENCE_DELAY_MS || 16000);
const RUN_ID = `remote-inference-${new Date().toISOString().replace(/[:.]/g, '-')}`;

const topicPalettes = [
  'weather, forests, oceans, wildlife, seasons, astronomy, and other natural observations',
  'computing, engineering, tools, architecture, transport, energy, and practical invention',
  'food, households, work, markets, education, sport, travel, and ordinary daily routines',
  'history, language, books, music, painting, theatre, archives, and cultural memory',
  'friendship, cooperation, curiosity, uncertainty, planning, imagination, and future societies',
];

const transports = [
  {
    name: 'pollinations-legacy-openai-post',
    endpoint: 'https://text.pollinations.ai/openai',
    async call(prompt, seed) {
      const response = await fetchWithTimeout(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: 'system',
              content: 'Generate synthetic English-language training data. Obey exact JSON and count constraints.',
            },
            { role: 'user', content: prompt },
          ],
          seed,
          temperature: 0.9,
          max_tokens: 6000,
          response_format: { type: 'json_object' },
          private: true,
        }),
      });
      return parseHttpResponse(response, this.name, this.endpoint);
    },
  },
  {
    name: 'pollinations-unified-openai-post',
    endpoint: 'https://gen.pollinations.ai/v1/chat/completions',
    async call(prompt, seed) {
      const response = await fetchWithTimeout(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: 'system',
              content: 'Generate synthetic English-language training data. Obey exact JSON and count constraints.',
            },
            { role: 'user', content: prompt },
          ],
          seed,
          temperature: 0.9,
          max_tokens: 6000,
          response_format: { type: 'json_object' },
        }),
      });
      return parseHttpResponse(response, this.name, this.endpoint);
    },
  },
  {
    name: 'pollinations-legacy-text-get',
    endpoint: 'https://text.pollinations.ai',
    async call(prompt, seed) {
      const url = new URL(`${this.endpoint}/${encodeURIComponent(prompt)}`);
      url.searchParams.set('model', MODEL);
      url.searchParams.set('seed', String(seed));
      url.searchParams.set('temperature', '0.9');
      url.searchParams.set('json', 'true');
      url.searchParams.set('private', 'true');
      const response = await fetchWithTimeout(url, { method: 'GET' });
      return parseHttpResponse(response, this.name, url.toString());
    },
  },
  {
    name: 'pollinations-unified-text-get',
    endpoint: 'https://gen.pollinations.ai/text',
    async call(prompt, seed) {
      const url = new URL(`${this.endpoint}/${encodeURIComponent(prompt)}`);
      url.searchParams.set('model', MODEL);
      url.searchParams.set('seed', String(seed));
      url.searchParams.set('temperature', '0.9');
      url.searchParams.set('json', 'true');
      const response = await fetchWithTimeout(url, { method: 'GET' });
      return parseHttpResponse(response, this.name, url.toString());
    },
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs = 300_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseHttpResponse(response, transport, endpoint) {
  const rawBody = await response.text();
  const headers = Object.fromEntries(
    [...response.headers.entries()].filter(([key]) =>
      ['content-type', 'x-request-id', 'cf-ray', 'retry-after'].includes(key.toLowerCase()),
    ),
  );
  if (!response.ok) {
    const error = new Error(`${transport} returned HTTP ${response.status}: ${rawBody.slice(0, 500)}`);
    error.httpStatus = response.status;
    error.rawBody = rawBody;
    error.headers = headers;
    throw error;
  }

  let content = rawBody;
  try {
    const parsed = JSON.parse(rawBody);
    content =
      parsed?.choices?.[0]?.message?.content ??
      parsed?.choices?.[0]?.text ??
      parsed?.response ??
      parsed?.text ??
      parsed;
    if (typeof content !== 'string') content = JSON.stringify(content);
  } catch {
    // A simple text endpoint returns the generated text directly.
  }

  return {
    transport,
    endpoint,
    httpStatus: response.status,
    headers,
    rawBody,
    content,
  };
}

function buildPrompt({ requested, batchIndex, existing }) {
  const exclusions = existing.slice(-30);
  return [
    `Return exactly ${requested} distinct, natural, standalone English sentences in this JSON shape:`,
    '{"sentences":["First complete sentence.","Second complete sentence."]}',
    '',
    `Dataset batch: ${batchIndex + 1}.`,
    `Topic palette: ${topicPalettes[batchIndex % topicPalettes.length]}.`,
    'Hard requirements:',
    `- Every sentence contains ${MIN_WORDS} to ${MAX_WORDS} words inclusive.`,
    '- Every sentence is grammatical, specific, safe, and ends with terminal punctuation.',
    '- Vary subjects, verbs, tense, syntax, vocabulary, and sentence length.',
    '- Do not use numbering, labels, quotations, fragments, slogans, or personal information.',
    '- Do not repeat or lightly paraphrase another item.',
    '- Return JSON only, with no Markdown fences or explanatory prose.',
    `- Fresh-generation nonce: ${RUN_ID}-batch-${batchIndex + 1}.`,
    exclusions.length
      ? `Avoid these already accepted sentences:\n${exclusions.map((sentence) => `- ${sentence}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
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
      // Continue with the next representation.
    }
  }

  return text
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

function validate(values, alreadySeen) {
  const accepted = [];
  const rejected = [];
  const localSeen = new Set();

  for (const value of values) {
    const sentence = normalizeSentence(value);
    const key = sentence.toLocaleLowerCase('en-US');
    const words = wordCount(sentence);
    let reason = null;

    if (!sentence) reason = 'empty';
    else if (words < MIN_WORDS || words > MAX_WORDS) reason = `word_count_${words}`;
    else if (!/[.!?]$/.test(sentence)) reason = 'missing_terminal_punctuation';
    else if (alreadySeen.has(key) || localSeen.has(key)) reason = 'duplicate';
    else if (sentence.length > 300) reason = 'too_long';

    if (reason) rejected.push({ sentence, reason });
    else {
      localSeen.add(key);
      accepted.push(sentence);
    }
  }
  return { accepted, rejected };
}

function summarizeRejections(rejected) {
  return rejected.reduce((summary, item) => {
    summary[item.reason] = (summary[item.reason] || 0) + 1;
    return summary;
  }, {});
}

async function callRemoteModel(prompt, seed, preferredTransportIndex) {
  const order = preferredTransportIndex == null
    ? transports.map((_, index) => index)
    : [preferredTransportIndex, ...transports.map((_, index) => index).filter((index) => index !== preferredTransportIndex)];
  const failures = [];

  for (const index of order) {
    const transport = transports[index];
    try {
      const response = await transport.call(prompt, seed);
      return { ...response, transportIndex: index, failuresBeforeSuccess: failures };
    } catch (error) {
      failures.push({
        transport: transport.name,
        endpoint: transport.endpoint,
        message: String(error?.message ?? error),
        httpStatus: error?.httpStatus ?? null,
        headers: error?.headers ?? null,
        rawBodyPreview: String(error?.rawBody ?? '').slice(0, 500),
      });
    }
  }

  throw new Error(`Every remote inference transport failed: ${JSON.stringify(failures)}`);
}

async function main() {
  const startedAt = new Date().toISOString();
  const acceptedRecords = [];
  const calls = [];
  const rawResponses = [];
  const seen = new Set();
  let preferredTransportIndex = null;
  let lastRequestAt = 0;

  for (let batchIndex = 0; acceptedRecords.length < TARGET; batchIndex += 1) {
    const batchTarget = Math.min(BATCH_SIZE, TARGET - acceptedRecords.length);
    let batchAccepted = 0;

    for (let attempt = 1; attempt <= 7 && batchAccepted < batchTarget; attempt += 1) {
      const requested = batchTarget - batchAccepted;
      const sinceLastRequest = Date.now() - lastRequestAt;
      if (lastRequestAt && sinceLastRequest < INTER_REQUEST_DELAY_MS) {
        await sleep(INTER_REQUEST_DELAY_MS - sinceLastRequest);
      }

      const prompt = buildPrompt({
        requested,
        batchIndex,
        existing: acceptedRecords.map((record) => record.sentence),
      });
      const seed = 2026080700 + batchIndex * 100 + attempt;
      const callStartedAt = new Date().toISOString();
      lastRequestAt = Date.now();

      let response;
      try {
        response = await callRemoteModel(prompt, seed, preferredTransportIndex);
        preferredTransportIndex = response.transportIndex;
      } catch (error) {
        calls.push({
          batch: batchIndex + 1,
          attempt,
          requested,
          seed,
          startedAt: callStartedAt,
          completedAt: new Date().toISOString(),
          error: String(error?.message ?? error),
        });
        if (attempt === 7) throw error;
        await sleep(Math.min(120_000, 10_000 * 2 ** (attempt - 1)));
        continue;
      }

      const parsed = extractCandidateArray(response.content);
      const validated = validate(parsed, seen);
      const room = batchTarget - batchAccepted;
      const taken = validated.accepted.slice(0, room);
      const callNumber = calls.length + 1;

      for (const sentence of taken) {
        seen.add(sentence.toLocaleLowerCase('en-US'));
        acceptedRecords.push({
          id: acceptedRecords.length + 1,
          sentence,
          batch: batchIndex + 1,
          attempt,
          call: callNumber,
          transport: response.transport,
          model: MODEL,
        });
      }
      batchAccepted += taken.length;

      const responseHash = createHash('sha256').update(response.rawBody).digest('hex');
      calls.push({
        call: callNumber,
        batch: batchIndex + 1,
        attempt,
        requested,
        seed,
        startedAt: callStartedAt,
        completedAt: new Date().toISOString(),
        transport: response.transport,
        endpoint: response.endpoint.split('?')[0],
        model: MODEL,
        httpStatus: response.httpStatus,
        responseHeaders: response.headers,
        failuresBeforeSuccess: response.failuresBeforeSuccess,
        responseSha256: responseHash,
        parsedCandidates: parsed.length,
        accepted: taken.length,
        rejected: validated.rejected.length,
        rejectionReasons: summarizeRejections(validated.rejected),
      });
      rawResponses.push({
        call: callNumber,
        batch: batchIndex + 1,
        attempt,
        transport: response.transport,
        endpoint: response.endpoint.split('?')[0],
        model: MODEL,
        responseSha256: responseHash,
        rawBody: response.rawBody,
      });

      console.log(
        `Batch ${batchIndex + 1}, attempt ${attempt}: accepted ${taken.length}/${requested}; total ${acceptedRecords.length}/${TARGET}; transport ${response.transport}`,
      );

      if (batchAccepted < batchTarget) await sleep(10_000 * attempt);
    }

    if (batchAccepted !== batchTarget) {
      throw new Error(`Batch ${batchIndex + 1} ended with ${batchAccepted}/${batchTarget} accepted sentences.`);
    }
  }

  if (acceptedRecords.length !== TARGET || seen.size !== TARGET) {
    throw new Error(`Final validation failed: count=${acceptedRecords.length}, unique=${seen.size}`);
  }

  const numberedText = acceptedRecords
    .map((record) => `${String(record.id).padStart(3, '0')}. ${record.sentence}`)
    .join('\n') + '\n';
  const jsonArray = acceptedRecords.map((record) => record.sentence);
  const jsonl = acceptedRecords.map((record) => JSON.stringify(record)).join('\n') + '\n';
  const rawJsonl = rawResponses.map((record) => JSON.stringify(record)).join('\n') + '\n';
  const sentenceHash = createHash('sha256').update(numberedText).digest('hex');
  const completedAt = new Date().toISOString();

  const manifest = {
    runId: RUN_ID,
    startedAt,
    completedAt,
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
      requestedModelAlias: MODEL,
      selectedTransport: calls.find((call) => call.transport)?.transport || null,
      selectedEndpoint: calls.find((call) => call.endpoint)?.endpoint || null,
      successfulHttpInferenceCalls: calls.filter((call) => call.httpStatus >= 200 && call.httpStatus < 300).length,
      callLog: calls,
    },
    validation: {
      targetCount: TARGET,
      actualCount: acceptedRecords.length,
      uniqueCount: seen.size,
      requiredWordCountRange: [MIN_WORDS, MAX_WORDS],
      allTerminallyPunctuated: acceptedRecords.every((record) => /[.!?]$/.test(record.sentence)),
      minObservedWords: Math.min(...acceptedRecords.map((record) => wordCount(record.sentence))),
      maxObservedWords: Math.max(...acceptedRecords.map((record) => wordCount(record.sentence))),
    },
    provenance: {
      sentencesSha256: sentenceHash,
      rawResponsesRecorded: rawResponses.length,
      note: 'Every accepted sentence was parsed from a successful remote inference API response; no local language model or static sentence bank was used.',
    },
  };

  const validationText = [
    `target_count=${TARGET}`,
    `actual_count=${acceptedRecords.length}`,
    `unique_count=${seen.size}`,
    `min_words=${manifest.validation.minObservedWords}`,
    `max_words=${manifest.validation.maxObservedWords}`,
    `all_terminally_punctuated=${manifest.validation.allTerminallyPunctuated}`,
    `remote_api_used=${manifest.inference.remoteApiUsed}`,
    `local_model_used=${manifest.inference.localModelUsed}`,
    `successful_http_inference_calls=${manifest.inference.successfulHttpInferenceCalls}`,
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
  await writeFile(
    'generated/FAILED.txt',
    `${new Date().toISOString()}\n${String(error?.stack || error)}\n`,
    'utf8',
  );
  process.exitCode = 1;
});
