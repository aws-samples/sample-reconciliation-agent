/**
 * What one case's agent run cost, priced from the token counts stored on the case record.
 *
 * The case detail screen shows total input / output / cached tokens and an estimated cost at the top
 * of the agent trace. This module is the arithmetic and the rate table behind that number and nothing
 * else: no fetching, no formatting, no React. Pure and DOM-free on purpose — a published price table
 * is exactly the kind of thing that goes stale wrong rather than stale broken, so the part worth
 * pinning in a test is the multiplication, and a test that has to mount a case page to check that
 * per-1M was not read as per-1K is a test nobody writes.
 *
 * Three properties of the stored usage shape drive most of the design here, and all three are facts
 * about what Bedrock reports rather than defensive habit:
 *
 *   - the cache token counts may be ABSENT rather than zero. Bedrock omits them from its usage payload
 *     when no caching occurred, so "no cache tokens were reported" and "zero cache tokens were used"
 *     arrive as different data and are kept apart all the way to the caller — see `UsageTokens`;
 *   - the model id may be absent or unrecognised. It is operator-settable through SSM
 *     (`/recon-dev/agent-model-id`, see `src/app/api/recon/config/route.ts`), and each backend falls
 *     back to its own deploy-time default when no selection is recorded, so an id this table has never
 *     heard of is an ordinary occurrence and not a bug;
 *   - the numbers come back through DynamoDB, so once `unmarshall` and `NextResponse.json` have had
 *     them they may be strings or `Decimal`-like rather than JS numbers.
 *
 * ⚠️ The estimate is a FLOOR, not a price. See `CACHE_WRITE_RATE_IS_A_FLOOR` below and the `isFloor`
 * field on the result — the caveat is carried in the return value rather than left in a comment,
 * because a comment cannot reach the operator reading the number.
 */

/** USD per 1,000,000 tokens for one model, in each of the five ways a token can be billed. */
export interface ModelRates {
  /** Ordinary uncached input. */
  inputPerMTok: number;
  /** Generated output, including tokens spent on thinking. */
  outputPerMTok: number;
  /** Writing a 5-minute-TTL cache entry. What `estimateAgentRunCost` prices writes at. */
  cacheWrite5mPerMTok: number;
  /** Writing a 1-hour-TTL cache entry. Recorded for the reader, never used by the arithmetic. */
  cacheWrite1hPerMTok: number;
  /** Reading an existing cache entry. */
  cacheReadPerMTok: number;
}

/**
 * Published Anthropic on-demand rates, USD per 1M tokens.
 *
 * SOURCE: AWS Bedrock pricing page, Anthropic on-demand, **Global Cross-region Inference** column,
 * region **US East (Ohio)**. RETRIEVED **2026-09-10**. Recorded so a reader can judge staleness
 * without guessing: a rate table with no provenance is indistinguishable from a rate table someone
 * made up, and these three rows will be wrong at some point without anything failing.
 *
 * The keys are the model ids from `AGENT_MODEL_IDS` in `src/app/api/recon/config/route.ts` with their
 * region prefix removed — see `ratesFor`, which does the removing. Those six ids (three models × two
 * prefixes) are the entire set of values the operator can select, and the terraform default
 * (`infra/environments/recon/variables.tf`, `us.anthropic.claude-sonnet-5`) is spelled the same way.
 *
 * ⚠️ **Claude Fable 5.1's cache read is 0.25, not 1.00.** The same published table carries a "Claude
 * Fable 5" row — a different, adjacent model — whose cache read is **1.00**, four times as much. The
 * two rows sit next to each other and their names differ by one character, so the next person
 * refreshing this table will be looking at exactly the pair that got this wrong once. Read the row
 * label, not the row position. (Fable 5 is not selectable here, which is why it is absent below rather
 * than listed: an id recon cannot be configured with must not be given a price it could be found by.)
 *
 * ⚠️ **ASSUMPTION: `us.` and `global.` price identically.** The figures above are already the Global
 * Cross-region Inference column, so both prefixes resolve to the same row. That is a statement about
 * today's pricing page and not a guarantee: `global.` routing may leave the US (the Config tab labels
 * it as a data-residency decision for that reason), and if the two columns ever diverge, THIS TABLE is
 * where it breaks — silently, by quoting a US price for a request that was not billed at one. The
 * region-prefix allowlist in `ratesFor` is the other half of that guard.
 */
const RATES_BY_MODEL: Readonly<Record<string, ModelRates>> = {
  "anthropic.claude-opus-5": {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheWrite5mPerMTok: 6.25,
    cacheWrite1hPerMTok: 10.0,
    cacheReadPerMTok: 0.5,
  },
  "anthropic.claude-sonnet-5": {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheWrite5mPerMTok: 2.5,
    cacheWrite1hPerMTok: 4.0,
    cacheReadPerMTok: 0.2,
  },
  "anthropic.claude-fable-5-1": {
    inputPerMTok: 10.0,
    outputPerMTok: 50.0,
    cacheWrite5mPerMTok: 12.5,
    cacheWrite1hPerMTok: 20.0,
    // 0.25 — NOT the 1.00 on the adjacent Claude Fable 5 row. See the table docstring.
    cacheReadPerMTok: 0.25,
  },
};

/**
 * The region prefixes these rates are known to apply to.
 *
 * An allowlist rather than "strip everything up to the first dot", and that is the point: the table is
 * the US East (Ohio) column, so `us.` and `global.` are covered by the assumption recorded above, while
 * `eu.` or `apac.` are NOT. A permissive strip would hand a European inference profile a US price and
 * call it a cost; refusing to recognise the id instead makes the gap visible as "no published rate",
 * which is true. Widening this list means checking the pricing page for that region first.
 */
const KNOWN_REGION_PREFIXES = ["us.", "global."] as const;

/**
 * The divisor every rate in `RATES_BY_MODEL` is quoted against.
 *
 * Named rather than written inline as `1e6`, because the units are the one thing about this module
 * that is worth being loud about: reading a $/MTok figure as $/KTok overstates every cost by exactly
 * 1000x and still renders as a plausible dollar amount.
 */
const TOKENS_PER_MTOK = 1_000_000;

/**
 * Why the estimate can only ever be a lower bound.
 *
 * Bedrock reports how many tokens were written to the prompt cache but not WHICH cache was written:
 * the 5-minute and the 1-hour TTL are separate line items at materially different prices (Opus 5:
 * 6.25 against 10.00 per MTok — 60% more). With no way to tell them apart from the stored usage, the
 * arithmetic uses the cheaper 5-minute rate, which makes the result a floor whenever any cache write
 * was reported. The alternative — quoting the 1-hour rate — would make it a ceiling and overstate the
 * common case, since the 5-minute TTL is the default. Neither is "the cost", so the result says which
 * one it is rather than pretending; `isFloor` on `PricedRun` is that statement.
 */
const CACHE_WRITE_RATE_IS_A_FLOOR = true;

/**
 * The usage record another task persists on the case record, as it arrives here.
 *
 * Every field is `unknown` deliberately. This crosses a DynamoDB round trip and a JSON serialisation,
 * so a field typed `number` here would be a claim this module cannot check and `estimateAgentRunCost`
 * would multiply a string by a rate and produce `NaN` dollars. `tokenCount` does the narrowing.
 */
export interface StoredUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  /** ABSENT when no cache read occurred — not 0. See the module docstring. */
  cache_read_tokens?: unknown;
  /** ABSENT when no cache write occurred — not 0. See the module docstring. */
  cache_write_tokens?: unknown;
  model_id?: unknown;
  /**
   * `"runtime"` | `"harness"`. Carried in the stored shape and deliberately ignored by the pricing:
   * both backends invoke the same Bedrock models through the same on-demand rates, so the backend
   * changes who called Bedrock and not what it charged. Reading it here would invent a distinction.
   */
  backend?: unknown;
}

/**
 * The four token counts, narrowed — with `null` meaning "not reported", never "zero".
 *
 * The distinction is the whole reason this is a separate type. A UI that renders `0` for an absent
 * `cache_read_tokens` asserts that the run was measured and used no cache, which is a claim about
 * caching behaviour nobody made; the correct rendering for `null` is an em dash. Both readings exist
 * live, because Bedrock omits the cache fields entirely on an uncached call.
 */
export interface UsageTokens {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/** A run that could be priced: a real cost, with the tokens it was computed from. */
export interface PricedRun {
  kind: "priced";
  /**
   * USD, unrounded. Formatting is the caller's — rounding here would bake a display decision into the
   * arithmetic and make the hand-computed test assert the formatter instead of the rates.
   */
  amountUsd: number;
  /**
   * TRUE when the real cost is at least `amountUsd` and possibly more: some cache write was reported
   * and was priced at the 5-minute rate. FALSE when no cache write was reported, which makes the
   * estimate exact against this table. Not hardcoded true — "at least $X" on a run with no caching
   * hedges a number that has nothing to hedge, and a caveat shown on every row is a caveat operators
   * stop reading.
   */
  isFloor: boolean;
  /** The stored id this was priced with, verbatim, so a displayed cost can name its model. */
  modelId: string;
  /** The rates used, so a caller can show the working rather than re-deriving it. */
  rates: ModelRates;
  /** What the cost was computed from. `null` entries were not reported — see `UsageTokens`. */
  tokens: UsageTokens;
}

/** A run whose model has no row in this table. Carries NO amount — see `estimateAgentRunCost`. */
export interface UnknownModelRun {
  kind: "unknownModel";
  /** The stored id, verbatim, or `null` when none was recorded. Shown so the gap is actionable. */
  modelId: string | null;
  /** The tokens are still known and still worth displaying; only the price is missing. */
  tokens: UsageTokens;
}

/** A run with no token counts at all: nothing was measured, so there is nothing to price. */
export interface NoUsageRun {
  kind: "noUsage";
}

/**
 * What a cost estimate can be, as three states the caller must tell apart.
 *
 * ⚠️ Deliberately NOT a bare `number`. The three outcomes are "this run cost about $X", "recon has no
 * published rate for the model this run used", and "no usage was recorded for this run at all", and a
 * function returning a number can only express the first — it has to signal the other two as `0` or
 * `null`, and `$0.00` beside an agent trace reads as "this run was free", which is never true of a run
 * that happened. Discriminating on `kind` makes that misreading impossible to write.
 */
export type CostEstimate = PricedRun | UnknownModelRun | NoUsageRun;

/**
 * One stored token count as a usable number, or `null`.
 *
 * ⚠️ Required, not cosmetic — same reason as `num` in `src/lib/idpDocumentStore.ts`. `unmarshall`
 * hands DynamoDB numerics back as `Decimal`-like objects and a JSON round trip can turn them into
 * strings; either one multiplied by a rate yields `NaN`, and `NaN` formatted for display is the word
 * "NaN" next to a dollar sign.
 *
 * `null` and never 0 when the value is absent or unusable, so an absent cache count cannot be read
 * downstream as a measured zero. A negative count is treated as unusable rather than priced: token
 * counts cannot be negative, so a negative one is corrupt data, and pricing it would subtract money
 * from the estimate — a corrupt row quietly making a run look cheaper is worse than a missing number,
 * which at least shows as absent.
 *
 * @param value - the stored attribute value, in whatever shape it survived the round trip in.
 * @returns the count, or null when it is absent, non-numeric, non-finite, or negative.
 */
function tokenCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  // ⚠️ NOT a `typeof value === "number"` gate, and not a `typeof number | string` one either — the
  // Decimal-like case is exactly the one those would reject. What has to be excluded instead is the
  // handful of values `Number` maps onto a plausible count out of nothing: `true` becomes 1, `[]`
  // becomes 0, and `[7]` becomes 7. None of those is a reported token count.
  if (typeof value === "boolean" || Array.isArray(value)) return null;
  // `Number("")` and `Number("   ")` are both 0 — a blank attribute is absence, not a measured zero.
  if (typeof value === "string" && value.trim() === "") return null;
  // Works over a Decimal-like because `NumberValue.valueOf()` yields its string form, which coerces;
  // anything else object-shaped lands on NaN and is rejected on the next line.
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Narrow a stored usage record's four token counts.
 *
 * Exported because the case screen displays the totals whether or not it can price them — the
 * `unknownModel` result carries these too, so an operator whose model is missing from the table still
 * sees what the run consumed.
 *
 * @param usage - the stored usage record, or null/undefined when the case has none.
 * @returns the four counts, `null` per count that was not reported.
 */
export function usageTokens(
  usage: StoredUsage | null | undefined,
): UsageTokens {
  return {
    input: tokenCount(usage?.input_tokens),
    output: tokenCount(usage?.output_tokens),
    cacheRead: tokenCount(usage?.cache_read_tokens),
    cacheWrite: tokenCount(usage?.cache_write_tokens),
  };
}

/**
 * The published rates for a stored model id, or `null` when this table has none.
 *
 * Strips a recognised region prefix and looks the remainder up. `null` rather than a throw or a
 * substituted default: the id is operator-settable and each backend carries its own deploy-time
 * default, so an unrecognised value is an ordinary state of the system. Defaulting to some other
 * model's rates would answer a question about money with another model's answer, and throwing would
 * cost the operator the whole case screen over a cost badge.
 *
 * @param modelId - the stored `model_id`, e.g. `us.anthropic.claude-opus-5`; null/absent is allowed.
 * @returns the rates, or null when the id is absent, blank, or not in the table.
 */
export function ratesFor(
  modelId: string | null | undefined,
): ModelRates | null {
  if (typeof modelId !== "string") return null;
  const id = modelId.trim();
  if (id === "") return null;
  const prefix = KNOWN_REGION_PREFIXES.find((p) => id.startsWith(p));
  // No recognised prefix means the id is left whole rather than guessed at, so an unprefixed or
  // foreign-region id misses the table instead of matching the wrong row.
  const key = prefix === undefined ? id : id.slice(prefix.length);
  return RATES_BY_MODEL[key] ?? null;
}

/**
 * Estimate what one agent run cost, as a state the caller has to unpack.
 *
 * The order of the two rejections matters and is not arbitrary. "No usage at all" is checked FIRST,
 * because a case whose agent never ran has neither token counts nor a model id, and reporting that as
 * `unknownModel` would blame the rate table for a run that never happened — sending someone to update
 * a price list to fix a case that has nothing to price.
 *
 * A reported zero is not absence. `{ input_tokens: 0, output_tokens: 0 }` prices as `priced` with
 * `amountUsd` 0, because those zeros were measured; only a record where none of the four counts is
 * usable is `noUsage`. The discriminated result is what makes that safe to display — a `priced` 0 and
 * an unpriceable run are different `kind`s, so no caller can render one as the other.
 *
 * ⚠️ The amount is a FLOOR whenever `isFloor` is true. See `CACHE_WRITE_RATE_IS_A_FLOOR`.
 *
 * @param usage - the usage record stored on the case, or null/undefined when it has none.
 * @returns `priced` with an amount, `unknownModel` with the id and the tokens, or `noUsage`.
 */
export function estimateAgentRunCost(
  usage: StoredUsage | null | undefined,
): CostEstimate {
  const tokens = usageTokens(usage);
  const anyReported =
    tokens.input !== null ||
    tokens.output !== null ||
    tokens.cacheRead !== null ||
    tokens.cacheWrite !== null;
  if (!anyReported) return { kind: "noUsage" };

  const modelId = typeof usage?.model_id === "string" ? usage.model_id : null;
  const rates = modelId === null ? null : ratesFor(modelId);
  // Both halves tested together so `modelId` narrows to `string` below. `ratesFor(null)` is null
  // anyway, so this is one state -- "recon cannot put a price on this run's model" -- reached either
  // by an id nobody recorded or by an id this table has never heard of.
  if (modelId === null || rates === null)
    return { kind: "unknownModel", modelId, tokens };

  // Every count is divided by `TOKENS_PER_MTOK` before it is multiplied, because every rate is a
  // $/MTok figure. `__tests__/lib/modelPricing.test.ts` pins this with a hand-computed total.
  //
  // An absent count contributes nothing, which is what `?? 0` does HERE and only here: the zero is a
  // local additive identity inside one sum and is never stored, returned, or displayed. The reported
  // counts stay in `tokens` exactly as they arrived, `null` and all.
  const amountUsd =
    ((tokens.input ?? 0) * rates.inputPerMTok) / TOKENS_PER_MTOK +
    ((tokens.output ?? 0) * rates.outputPerMTok) / TOKENS_PER_MTOK +
    ((tokens.cacheRead ?? 0) * rates.cacheReadPerMTok) / TOKENS_PER_MTOK +
    // The 5-minute write rate, which is what makes the total a floor rather than a price.
    ((tokens.cacheWrite ?? 0) * rates.cacheWrite5mPerMTok) / TOKENS_PER_MTOK;

  return {
    kind: "priced",
    amountUsd,
    // Only when a write was actually reported: with no cache write there is no 5m/1h ambiguity left
    // to warn about, and the estimate is exact against this table.
    isFloor: CACHE_WRITE_RATE_IS_A_FLOOR && (tokens.cacheWrite ?? 0) > 0,
    modelId,
    rates,
    tokens,
  };
}
