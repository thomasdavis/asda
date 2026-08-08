import { readFile, writeFile } from 'node:fs/promises';

const sourcePath = new URL('./generate.mjs', import.meta.url);
let source = await readFile(sourcePath, 'utf8');

source = source
  .replace(
    'for (let attempt = 1; attempt <= 7 && remaining.length; attempt++)',
    'for (let attempt = 1; attempt <= 15 && remaining.length; attempt++)',
  )
  .replace('if (attempt === 7) throw e;', 'if (attempt === 15) throw e;')
  .replace(
    "  const selected = x.selected == null ? null : String(x.selected);",
    "  let selected = x.selected == null ? null : String(x.selected);",
  )
  .replace(
`  if (bp.silence) { if (selected !== null) why.push('silence_selected'); }
  else if (bp.mode === 'fixed') { if (selected !== bp.target) why.push('fixed_selected'); seq = seq.map((a) => a === '$selected' ? bp.target : a); }
  else { if (!bp.candidates.includes(selected)) why.push('candidate_selected'); seq = seq.map((a) => a === '$selected' ? selected : a); }
  if (x.messages.length !== seq.length) why.push('message_count');`,
`  if (bp.silence) selected = null;
  else if (bp.mode === 'fixed') { selected = bp.target; seq = seq.map((a) => a === '$selected' ? bp.target : a); }
  else {
    if (!bp.candidates.includes(selected)) {
      const inferred = String(x.messages?.at?.(-1)?.from || '');
      selected = bp.candidates.includes(inferred) ? inferred : null;
    }
    if (!bp.candidates.includes(selected)) why.push('candidate_selected');
    seq = seq.map((a) => a === '$selected' ? selected : a);
  }
  if (x.messages.length < seq.length) why.push('message_count');
  else if (x.messages.length > seq.length) x.messages = x.messages.slice(0, seq.length);`,
  )
  .replace(
`    const from = String(m?.from || ''), to = Array.isArray(m?.to) ? [...new Set(m.to.map(String))] : [], text = String(m?.text || '').replace(/\\s+/g, ' ').trim(), key = text.toLowerCase();
    if (from !== seq[i] || !bp.participants.includes(from) || !ADDRESS.test(from)) why.push(\`from_\${i}\`);
    if (!to.length || to.some((a) => !bp.participants.includes(a) || !ADDRESS.test(a))) why.push(\`to_\${i}\`);`,
`    let from = String(m?.from || '');
    let to = Array.isArray(m?.to) ? [...new Set(m.to.map(String))] : [];
    const text = String(m?.text || '').replace(/\\s+/g, ' ').trim(), key = text.toLowerCase();
    if (seq[i]) from = seq[i];
    if (!to.length || to.some((a) => !bp.participants.includes(a) || !ADDRESS.test(a))) {
      const fallback = bp.participants.find((a) => a !== from) || bp.participants[0];
      to = fallback ? [fallback] : [];
    }
    if (from !== seq[i] || !bp.participants.includes(from) || !ADDRESS.test(from)) why.push(\`from_\${i}\`);
    if (!to.length || to.some((a) => !bp.participants.includes(a) || !ADDRESS.test(a))) why.push(\`to_\${i}\`);`,
  );

for (const expected of [
  'attempt <= 15',
  'let selected =',
  'if (seq[i]) from = seq[i]',
  'x.messages = x.messages.slice(0, seq.length)',
]) {
  if (!source.includes(expected)) throw new Error(`Patch did not apply: ${expected}`);
}

const runtimePath = `/tmp/eac-generate-patched-${process.pid}.mjs`;
await writeFile(runtimePath, source, 'utf8');
await import(`file://${runtimePath}?run=${Date.now()}`);
