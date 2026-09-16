import { describe, expect, it } from "vitest";

import {
  estimateAgentRunCost,
  ratesFor,
  usageTokens,
  type StoredUsage,
} from "@/lib/modelPricing";

/**
 * A fully-populated usage record; tests that only care about one field override it here.
 *
 * ⚠️ Every test about ABSENT fields builds its own literal instead of overriding this one, and that is
 * deliberate: `...overrides` cannot express "this key is missing" — `{ cache_read_tokens: undefined }`
 * leaves the key present with an undefined value. Spreading a default to test absence is how an
 * absent-vs-zero test ends up asserting the helper rather than the code under test.
 */
function usage(overrides: Partial<StoredUsage> = {}): StoredUsage {
  return {
    input_tokens: 100_000,
    output_tokens: 20_000,
    cache_read_tokens: 50_000,
    cache_write_tokens: 10_000,
    model_id: "us.anthropic.claude-opus-5",
    backend: "runtime",
    ...overrides,
  };
}

/** Narrow to `priced` and fail loudly rather than reading `amountUsd` off a union. */
function priced(estimate: ReturnType<typeof estimateAgentRunCost>) {
  if (estimate.kind !== "priced")
    throw new Error(`expected a priced estimate, got ${estimate.kind}`);
  return estimate;
}

describe("the hand-computed total pins the units", () => {
  /**
   * ⭐️ The most valuable assertion in this file: it is the one that fails if the rates are ever read
   * as $/1K instead of $/1M — a 1000x error that still renders as a plausible dollar amount.
   *
   * Worked by hand from the Opus 5 row (input 5.00, output 25.00, cache write 5m 6.25, cache read
   * 0.50 — all USD per 1,000,000 tokens):
   *
   *     input       1,500,000 tok = 1.5   MTok x  5.00 = $ 7.50
   *     output        300,000 tok = 0.3   MTok x 25.00 = $ 7.50
   *     cache read  2,000,000 tok = 2.0   MTok x  0.50 = $ 1.00
   *     cache write   400,000 tok = 0.4   MTok x  6.25 = $ 2.50   <- 5-minute rate, hence a floor
   *                                                       -------
   *                                                       $18.50
   *
   * Counts chosen so every term lands on an exact half-dollar and the total is a round 18.50: a
   * plausible-looking wrong answer cannot hide in float dust. Read per-1K, the same run would come out
   * at $18,500.00.
   */
  it("prices a four-way Opus 5 run at exactly $18.50", () => {
    const estimate = priced(
      estimateAgentRunCost({
        input_tokens: 1_500_000,
        output_tokens: 300_000,
        cache_read_tokens: 2_000_000,
        cache_write_tokens: 400_000,
        model_id: "us.anthropic.claude-opus-5",
      }),
    );
    expect(estimate.amountUsd).toBeCloseTo(18.5, 10);
    // Belt and braces on the units alone: a rate table quoted per 1M means 1M input tokens costs
    // exactly one input rate, with no arithmetic in between to get wrong.
    expect(
      priced(
        estimateAgentRunCost({
          input_tokens: 1_000_000,
          model_id: "us.anthropic.claude-opus-5",
        }),
      ).amountUsd,
    ).toBeCloseTo(5.0, 10);
  });
});

describe("each selectable model prices from its own row", () => {
  /** 1M input + 1M output, so the assertion reads straight off the published row. */
  const oneMTokEach = (model: string): number =>
    priced(
      estimateAgentRunCost({
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        model_id: model,
      }),
    ).amountUsd;

  it("prices Opus 5 at 5.00 + 25.00", () => {
    expect(oneMTokEach("us.anthropic.claude-opus-5")).toBeCloseTo(30.0, 10);
  });

  it("prices Sonnet 5 at 2.00 + 10.00", () => {
    expect(oneMTokEach("us.anthropic.claude-sonnet-5")).toBeCloseTo(12.0, 10);
  });

  it("prices Fable 5.1 at 10.00 + 50.00", () => {
    expect(oneMTokEach("us.anthropic.claude-fable-5-1")).toBeCloseTo(60.0, 10);
  });

  it("gives Fable 5.1 the 0.25 cache read, not the 1.00 from the adjacent Fable 5 row", () => {
    // 4M cache-read tokens: $1.00 at the correct rate, $4.00 at Fable 5's. Four times apart, so this
    // cannot pass with the wrong row copied off the pricing page.
    const estimate = priced(
      estimateAgentRunCost({
        cache_read_tokens: 4_000_000,
        model_id: "us.anthropic.claude-fable-5-1",
      }),
    );
    expect(estimate.amountUsd).toBeCloseTo(1.0, 10);
    expect(estimate.rates.cacheReadPerMTok).toBe(0.25);
  });
});

describe("cached tokens are part of the total", () => {
  it("adds cache reads and cache writes to the input and output cost", () => {
    const withoutCache = priced(
      estimateAgentRunCost({
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        model_id: "us.anthropic.claude-opus-5",
      }),
    ).amountUsd;
    const withCache = priced(
      estimateAgentRunCost({
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_tokens: 1_000_000,
        cache_write_tokens: 1_000_000,
        model_id: "us.anthropic.claude-opus-5",
      }),
    ).amountUsd;
    // 0.50 for the read + 6.25 for the write, on top of the 30.00 the uncached run costs.
    expect(withoutCache).toBeCloseTo(30.0, 10);
    expect(withCache).toBeCloseTo(36.75, 10);
  });
});

describe("the floor caveat lives in the return value", () => {
  it("marks a run with cache writes as a floor, because the 5m/1h TTL is unknowable", () => {
    const estimate = priced(estimateAgentRunCost(usage()));
    expect(estimate.isFloor).toBe(true);
  });

  it("does not hedge a run that reported no cache write", () => {
    const noWrite = priced(
      estimateAgentRunCost({
        input_tokens: 1_000,
        output_tokens: 1_000,
        model_id: "us.anthropic.claude-opus-5",
      }),
    );
    expect(noWrite.isFloor).toBe(false);
    // A reported ZERO writes is equally unambiguous: there is no 5m-vs-1h question to warn about.
    expect(
      priced(estimateAgentRunCost(usage({ cache_write_tokens: 0 }))).isFloor,
    ).toBe(false);
  });

  it("prices writes at the 5-minute rate, and records the 1-hour rate for the reader", () => {
    const estimate = priced(
      estimateAgentRunCost({
        cache_write_tokens: 1_000_000,
        model_id: "us.anthropic.claude-opus-5",
      }),
    );
    // 6.25, the 5m rate — not 10.00, the 1h rate. That gap is exactly why the total is a floor.
    expect(estimate.amountUsd).toBeCloseTo(6.25, 10);
    expect(estimate.rates.cacheWrite5mPerMTok).toBe(6.25);
    expect(estimate.rates.cacheWrite1hPerMTok).toBe(10.0);
  });
});

describe("an unpriceable model is a state, not a zero", () => {
  it("reports an unknown model id with no amount at all", () => {
    const estimate = estimateAgentRunCost(
      usage({ model_id: "us.anthropic.claude-nonesuch-9" }),
    );
    expect(estimate.kind).toBe("unknownModel");
    // The point of the discriminated result: there is no `amountUsd` field to mistake for $0.00.
    expect(estimate).not.toHaveProperty("amountUsd");
    if (estimate.kind !== "unknownModel") throw new Error("unreachable");
    expect(estimate.modelId).toBe("us.anthropic.claude-nonesuch-9");
    // The tokens are still known and still worth showing; only the price is missing.
    expect(estimate.tokens.input).toBe(100_000);
  });

  it("reports an absent model id the same way, naming it as null", () => {
    for (const record of [
      usage({ model_id: undefined }),
      usage({ model_id: null }),
      usage({ model_id: "" }),
      usage({ model_id: "   " }),
    ]) {
      const estimate = estimateAgentRunCost(record);
      expect(estimate.kind).toBe("unknownModel");
      expect(estimate).not.toHaveProperty("amountUsd");
    }
    const absent = estimateAgentRunCost(usage({ model_id: undefined }));
    if (absent.kind !== "unknownModel") throw new Error("unreachable");
    expect(absent.modelId).toBeNull();
  });

  it("refuses a foreign-region prefix rather than quoting it a US price", () => {
    // These rates are the US East (Ohio) column. `eu.` is not covered by that, so it must miss the
    // table instead of matching the row its suffix happens to look like.
    expect(ratesFor("eu.anthropic.claude-opus-5")).toBeNull();
    expect(
      estimateAgentRunCost(usage({ model_id: "eu.anthropic.claude-opus-5" }))
        .kind,
    ).toBe("unknownModel");
  });
});

describe("ratesFor", () => {
  it("resolves the global. prefix to the same rates as us.", () => {
    // Both prefixes are the Global Cross-region Inference column, which is the assumption recorded on
    // RATES_BY_MODEL. Same object identity, so the two can never drift apart in the table.
    for (const model of [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5-1",
    ]) {
      const us = ratesFor(`us.anthropic.${model}`);
      const global = ratesFor(`global.anthropic.${model}`);
      expect(us).not.toBeNull();
      expect(global).toBe(us);
    }
  });

  it("returns null for an absent or unrecognised id instead of throwing", () => {
    expect(ratesFor(null)).toBeNull();
    expect(ratesFor(undefined)).toBeNull();
    expect(ratesFor("")).toBeNull();
    expect(ratesFor("claude-opus-5")).toBeNull(); // no vendor prefix — not a stored id
    expect(ratesFor("us.anthropic.claude-opus-4-8")).toBeNull();
  });
});

describe("absent cache counts are not zero", () => {
  it("keeps an unreported cache count as null rather than defaulting it to 0", () => {
    // A record Bedrock produced for an uncached call: the cache keys are ABSENT, not zero.
    const uncached: StoredUsage = {
      input_tokens: 100_000,
      output_tokens: 20_000,
      model_id: "us.anthropic.claude-opus-5",
    };
    expect(usageTokens(uncached)).toEqual({
      input: 100_000,
      output: 20_000,
      cacheRead: null,
      cacheWrite: null,
    });
    // And it survives to the caller, so the UI can render an em dash rather than assert "0 cached".
    expect(priced(estimateAgentRunCost(uncached)).tokens.cacheRead).toBeNull();
  });

  it("keeps a reported zero as 0, which is a different fact", () => {
    const measuredZero = usageTokens(
      usage({ cache_read_tokens: 0, cache_write_tokens: 0 }),
    );
    expect(measuredZero.cacheRead).toBe(0);
    expect(measuredZero.cacheWrite).toBe(0);
  });

  it("contributes nothing to the cost for an absent count", () => {
    const absent = priced(
      estimateAgentRunCost({
        input_tokens: 1_000_000,
        model_id: "us.anthropic.claude-opus-5",
      }),
    ).amountUsd;
    const explicitZeros = priced(
      estimateAgentRunCost({
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        model_id: "us.anthropic.claude-opus-5",
      }),
    ).amountUsd;
    // Same money either way — absence and zero differ in what they SAY, not in what they cost.
    expect(absent).toBeCloseTo(5.0, 10);
    expect(explicitZeros).toBeCloseTo(5.0, 10);
  });
});

describe("no usage at all", () => {
  it("returns noUsage for a missing record", () => {
    expect(estimateAgentRunCost(null).kind).toBe("noUsage");
    expect(estimateAgentRunCost(undefined).kind).toBe("noUsage");
    expect(estimateAgentRunCost({}).kind).toBe("noUsage");
  });

  it("returns noUsage even when a model id was recorded, because nothing was measured", () => {
    // Checked BEFORE the model lookup on purpose: calling this `unknownModel` would blame the rate
    // table for a run that never happened.
    expect(
      estimateAgentRunCost({ model_id: "us.anthropic.claude-opus-5" }).kind,
    ).toBe("noUsage");
    // ...and still noUsage when the id is one nobody recognises, for the same reason.
    expect(estimateAgentRunCost({ model_id: "nonesuch" }).kind).toBe("noUsage");
  });

  it("treats a measured all-zero run as priced, not as absent", () => {
    // Every count is 0 but every count was REPORTED, so $0.00 here is a measurement rather than a
    // stand-in for "unknown" — and its `kind` says so, which is what stops it reading as "free".
    const estimate = priced(
      estimateAgentRunCost({
        input_tokens: 0,
        output_tokens: 0,
        model_id: "us.anthropic.claude-opus-5",
      }),
    );
    expect(estimate.amountUsd).toBe(0);
    expect(estimate.isFloor).toBe(false);
  });

  it("treats unusable values as unreported rather than as zero", () => {
    // Garbage and impossible values miss the arithmetic entirely: a negative token count is corrupt
    // data, and pricing it would SUBTRACT money and make a broken row look cheap.
    expect(
      estimateAgentRunCost({
        input_tokens: "not a number",
        output_tokens: -5,
        model_id: "us.anthropic.claude-opus-5",
      }).kind,
    ).toBe("noUsage");
  });
});

describe("the DynamoDB round trip", () => {
  it("prices counts that arrived as strings", () => {
    // What a Decimal-like attribute looks like after `unmarshall` and a JSON serialisation. Multiplied
    // as-is, a string yields NaN dollars, so this is the shape that decides whether the coercion runs.
    const asStrings = priced(
      estimateAgentRunCost({
        input_tokens: "1500000",
        output_tokens: "300000",
        cache_read_tokens: "2000000",
        cache_write_tokens: "400000",
        model_id: "us.anthropic.claude-opus-5",
      }),
    );
    // The same $18.50 as the hand-computed case above, and the counts come back as numbers.
    expect(asStrings.amountUsd).toBeCloseTo(18.5, 10);
    expect(asStrings.tokens.input).toBe(1_500_000);
  });

  it("prices a Decimal-like object whose valueOf yields its string form", () => {
    // `NumberValue` from @aws-sdk/util-dynamodb behaves like this; `Number()` coerces it via valueOf.
    const decimalLike = { value: "1000000", valueOf: () => "1000000" };
    const estimate = priced(
      estimateAgentRunCost({
        input_tokens: decimalLike,
        model_id: "us.anthropic.claude-opus-5",
      }),
    );
    expect(estimate.amountUsd).toBeCloseTo(5.0, 10);
    expect(estimate.tokens.input).toBe(1_000_000);
  });

  it("does not turn a booleanish or arrayish attribute into a count", () => {
    // `Number(true)` is 1 and `Number([])` is 0, so a permissive coercion would report a token count
    // for a row that carries none — and `noUsage` would silently become a priced $0.00 run.
    expect(usageTokens({ input_tokens: true, output_tokens: [] })).toEqual({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    });
  });
});
