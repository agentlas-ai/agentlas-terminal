"use strict";
/*
 * usage-normalizer — one provider-usage normalizer per dialect (G16). CJS port of the Desktop's
 * shared/observed-usage.ts normalizeProviderUsage; keep the two in step (same dialect rules, same
 * rejection reasons).
 *
 * Providers disagree on what "input" means. Anthropic: input_tokens EXCLUDES cache; total = input +
 * creation + read. OpenAI chat/Responses and Ollama: the cached part is a SUBSET of the input. Gemini:
 * promptTokenCount already includes cachedContentTokenCount. Everything maps to one shape; a field the
 * provider did not report stays undefined (never 0); an impossible report is rejected as a whole with a
 * machine reason.
 */

const absent = { absent: true };

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** One counter: absent -> {absent}, invalid -> {bad: reason}, else {value}. */
function readCount(value) {
  if (value === undefined || value === null) return absent;
  if (typeof value !== "number") return { bad: "not_integer" };
  if (Number.isNaN(value)) return { bad: "nan" };
  if (!Number.isFinite(value) || !Number.isInteger(value)) return { bad: "not_integer" };
  if (value < 0) return { bad: "negative" };
  if (!Number.isSafeInteger(value)) return { bad: "not_integer" };
  return { value };
}

function normalizeProviderUsage(dialect, raw) {
  const reject = (rejected) => ({ dialect, rejected });
  const u = asRecord(raw);
  if (!u) return reject("not_an_object");
  let inputRaw, cacheReadRaw, cacheWriteRaw, outputRaw;
  switch (dialect) {
    case "anthropic":
      inputRaw = u.input_tokens; cacheReadRaw = u.cache_read_input_tokens;
      cacheWriteRaw = u.cache_creation_input_tokens; outputRaw = u.output_tokens; break;
    case "openai-chat":
      inputRaw = u.prompt_tokens; cacheReadRaw = asRecord(u.prompt_tokens_details)?.cached_tokens;
      outputRaw = u.completion_tokens; break;
    case "openai-responses":
      inputRaw = u.input_tokens; cacheReadRaw = asRecord(u.input_tokens_details)?.cached_tokens;
      outputRaw = u.output_tokens; break;
    case "gemini":
      // candidatesTokenCount excludes thoughts; billed output is candidates + thoughts when reported.
      inputRaw = u.promptTokenCount; cacheReadRaw = u.cachedContentTokenCount; outputRaw = u.candidatesTokenCount; break;
    case "ollama":
      inputRaw = u.prompt_eval_count; outputRaw = u.eval_count; break;
    default:
      // Already-logical shape (CLI runtimes, accumulated receipts).
      inputRaw = u.inputTokens; cacheReadRaw = u.cachedInputTokens; cacheWriteRaw = u.cacheCreationInputTokens;
      outputRaw = u.outputTokens;
  }
  const input = readCount(inputRaw);
  const read = readCount(cacheReadRaw);
  const write = readCount(cacheWriteRaw);
  let output = readCount(outputRaw);
  if (dialect === "gemini" && "value" in output) {
    const thoughts = readCount(u.thoughtsTokenCount);
    if ("bad" in thoughts) return reject(thoughts.bad);
    if ("value" in thoughts) output = { value: output.value + thoughts.value };
  }
  for (const field of [input, read, write, output]) if ("bad" in field) return reject(field.bad);
  const base = "value" in input ? input.value : undefined;
  const cachedRead = "value" in read ? read.value : undefined;
  const cacheWrite = "value" in write ? write.value : undefined;
  const out = "value" in output ? output.value : undefined;
  if (base === undefined && cachedRead === undefined && cacheWrite === undefined && out === undefined) return reject("missing_input");
  let totalInput;
  let fresh;
  if (dialect === "anthropic") {
    // total = input + creation + read, only when all three are reported (a missing part is not 0).
    if (base !== undefined && cachedRead !== undefined && cacheWrite !== undefined) {
      totalInput = base + cachedRead + cacheWrite; fresh = base;
    } else if (base !== undefined && cachedRead === undefined && cacheWrite === undefined) {
      totalInput = undefined; fresh = base;
    }
    if (!Number.isSafeInteger(totalInput ?? 0)) return reject("not_integer");
  } else {
    totalInput = base;
    if (totalInput !== undefined) {
      if ((cachedRead ?? 0) + (cacheWrite ?? 0) > totalInput) return reject("cache_exceeds_total");
      if (cachedRead !== undefined) fresh = totalInput - cachedRead - (cacheWrite ?? 0);
    }
  }
  return {
    dialect,
    ...(totalInput !== undefined ? { totalInput } : {}),
    ...(cachedRead !== undefined ? { cachedRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(fresh !== undefined ? { uncached: fresh } : {}),
    ...(out !== undefined ? { output: out } : {}),
  };
}

/*
 * Sums normalized per-call usage across the iterations of one turn. A call whose side is unknown or whose
 * report was rejected makes that side of the TOTAL unknown (undefined) -- an unknown is never folded into 0.
 * total() returns undefined when nothing was recorded at all.
 */
function createUsageSum() {
  let calls = 0;
  let input = 0, output = 0, cached = 0, written = 0;
  let inputKnown = true, outputKnown = true, cachedKnown = true, writtenKnown = true;
  return {
    add(normalized) {
      calls += 1;
      const n = normalized && !normalized.rejected ? normalized : {};
      if (n.totalInput === undefined) inputKnown = false; else input += n.totalInput;
      if (n.output === undefined) outputKnown = false; else output += n.output;
      if (n.cachedRead === undefined) cachedKnown = false; else cached += n.cachedRead;
      if (n.cacheWrite === undefined) writtenKnown = false; else written += n.cacheWrite;
    },
    total() {
      if (!calls) return undefined;
      return {
        ...(inputKnown ? { input_tokens: input } : {}),
        ...(outputKnown ? { output_tokens: output } : {}),
        ...(cachedKnown ? { cache_read_input_tokens: cached } : {}),
        ...(writtenKnown ? { cache_creation_input_tokens: written } : {}),
        ...(!inputKnown ? { input_unknown: true } : {}),
        ...(!outputKnown ? { output_unknown: true } : {}),
      };
    },
  };
}

/*
 * Native-CLI usage -> the engine's snake_case usage object. Only fields the CLI really reported appear; a
 * missing/invalid side is omitted and flagged input_unknown / output_unknown (never folded into 0). `raw` is
 * the CLI's own usage object; `dialect` is how that CLI counts ("anthropic": input excludes cache, "unknown":
 * already-logical {inputTokens,outputTokens,cachedInputTokens}). `extra` (cost_usd, duration_ms) passes through.
 */
function cliUsageFromNormalized(n, cachedKey, extra) {
  const bad = !n || n.rejected;
  const input = bad ? undefined : (n.dialect === "anthropic" ? n.uncached : n.totalInput);
  const out = {
    ...(input !== undefined ? { input_tokens: input } : { input_unknown: true }),
    ...(!bad && n.output !== undefined ? { output_tokens: n.output } : { output_unknown: true }),
    ...(!bad && n.cachedRead !== undefined ? { [cachedKey]: n.cachedRead } : {}),
    ...(!bad && n.cacheWrite !== undefined ? { cache_creation_input_tokens: n.cacheWrite } : {}),
  };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

function normalizeCliUsage(dialect, raw, extra) {
  if (dialect === "anthropic") {
    const n = normalizeProviderUsage("anthropic", raw);
    // input_tokens is the fresh part by definition; a partially reported cache split must not hide it.
    if (!n.rejected && n.uncached === undefined && Number.isSafeInteger(raw.input_tokens)) n.uncached = raw.input_tokens;
    return cliUsageFromNormalized(n, "cache_read_input_tokens", extra);
  }
  const r = raw && typeof raw === "object" ? raw : {};
  const logical = { inputTokens: r.input_tokens, outputTokens: r.output_tokens,
    cachedInputTokens: r.cached_input_tokens, cacheCreationInputTokens: r.cache_creation_input_tokens };
  return cliUsageFromNormalized(normalizeProviderUsage("unknown", logical), "cached_input_tokens", extra);
}

/** Workforce token-ledger counts for one stage call: {input, output, cached}, each a count or null (unknown). */
function stageTokenCounts(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  const n = normalizeProviderUsage("unknown", {
    inputTokens: u.inputTokens ?? u.input_tokens,
    outputTokens: u.outputTokens ?? u.output_tokens,
    cachedInputTokens: u.cachedInputTokens ?? u.cached_input_tokens,
  });
  const ok = !n.rejected;
  return {
    input: ok && n.totalInput !== undefined ? n.totalInput : null,
    output: ok && n.output !== undefined ? n.output : null,
    cached: ok && n.cachedRead !== undefined ? n.cachedRead : null,
  };
}

module.exports = { normalizeProviderUsage, createUsageSum, normalizeCliUsage, stageTokenCounts };
