/**
 * Guards that the sample payloads keep matching the backend that decides their outcome.
 *
 * The samples are the only end-to-end validation of the two-tier flow without an upstream IDP
 * accelerator, and each one claims a specific outcome in its `expectation` text. A sample whose
 * claim has quietly stopped being true is worse than no sample: it makes a broken pipeline look
 * validated. So these tests read the actual Python that decides — the tolerance rule in
 * `backend/tier1/handler.py` and `BREAK_TYPE_RULES` in `backend/tier1/classify.py` — rather than
 * restating the expected values here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RECON_SAMPLES, withUniqueIds } from "@/lib/reconSamples";

const REPO = join(process.cwd(), "../..");
const HANDLER = readFileSync(join(REPO, "backend/tier1/handler.py"), "utf8");
const CLASSIFY = readFileSync(join(REPO, "backend/tier1/classify.py"), "utf8");

/** The `cash` domain's tolerance, read out of the Python rule table the stream consumer uses. */
function cashTolerance(): number {
  const rule = HANDLER.match(
    /"cash":\s*\{[^}]*"match_attr":\s*"amount"[^}]*"tolerance":\s*"([\d.]+)"/,
  );
  expect(
    rule,
    "could not find the cash rule in backend/tier1/handler.py",
  ).toBeTruthy();
  return Number(rule![1]);
}

const sample = (prefix: string) => {
  const found = RECON_SAMPLES.find((s) => s.label.startsWith(prefix));
  expect(found, `no sample labelled ${prefix}`).toBeTruthy();
  return found!;
};

const sidesOf = (s: (typeof RECON_SAMPLES)[number]) =>
  (s.payload.items[0].sides ?? []) as {
    name: string;
    attributes?: Record<string, string>;
  }[];

const amountSpread = (s: (typeof RECON_SAMPLES)[number]) => {
  const amounts = sidesOf(s).map((side) => Number(side.attributes?.amount));
  return Math.abs(amounts[0] - amounts[1]);
};

describe("recon sample payloads", () => {
  it("every sample is a valid intake payload shape", () => {
    for (const s of RECON_SAMPLES) {
      expect(s.payload.domain).toBeTruthy();
      expect(s.expectation).toBeTruthy();
      expect(s.payload.items.length).toBeGreaterThan(0);
      for (const it of s.payload.items) expect(it.item_id).toBeTruthy();
    }
  });

  it("all sides attribute values are strings (ReconSide.attributes is dict[str, str])", () => {
    for (const s of RECON_SAMPLES)
      for (const it of s.payload.items)
        for (const side of (it.sides as {
          attributes?: Record<string, unknown>;
        }[]) ?? [])
          for (const v of Object.values(side.attributes ?? {}))
            expect(typeof v).toBe("string");
  });

  it("every sample targets a domain Tier-1 has a rule for", () => {
    // An unknown domain escalates with `no_rule`, which is a different branch from the one every
    // sample claims to exercise — and it would make the auto-clear sample simply not auto-clear.
    for (const s of RECON_SAMPLES)
      expect(HANDLER).toContain(`"${s.payload.domain}": {`);
  });

  it("item_ids are unique across all samples", () => {
    // The UI can submit several samples; a collision would be silently skipped by put_if_absent.
    const ids = RECON_SAMPLES.flatMap((s) =>
      s.payload.items.map((it) => it.item_id),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the auto-clear sample is inside the configured tolerance", () => {
    expect(amountSpread(sample("Auto-clear"))).toBeLessThanOrEqual(
      cashTolerance(),
    );
  });

  it("the two-sided break sample is outside the configured tolerance", () => {
    // Otherwise it auto-clears and never reaches the agent, so nothing it claims gets exercised.
    expect(amountSpread(sample("Scenario 3"))).toBeGreaterThan(cashTolerance());
  });

  it.each([["Scenario 3", "record-match-review", 2]])(
    "the %s sample has the side_count that BREAK_TYPE_RULES maps to %s",
    (prefix, skill, sideCount) => {
      // Pinned against the rule table itself: the rules partition on side_count, so a sample with
      // the wrong number of sides gets a different break type than its label promises.
      expect(CLASSIFY).toContain(
        `("${skill}", lambda record: record.get("side_count") == ${sideCount})`,
      );
      expect(sidesOf(sample(prefix))).toHaveLength(sideCount as number);
    },
  );

  it("no sample submits a zero-sided item", () => {
    // A zero-sided item is what the extraction pipeline produces, not what an operator types. Offering
    // one in this modal demos a route no document takes, and the two removed samples that did were read
    // as "this is how a document arrives" — which sent people looking for a modal that ingests files.
    for (const s of RECON_SAMPLES)
      for (const it of s.payload.items)
        expect(
          (it.sides as unknown[]).length,
          `${s.label} submits an item with no sides`,
        ).toBeGreaterThan(0);
  });

  it("the no-rule sample has a side_count no rule claims", () => {
    // This sample exists to keep the agent's own classifier on a live path. If a future rule covers
    // its side count, Tier-1 starts stamping a hint and the model-classification route goes
    // untested again.
    const sideCount = sidesOf(sample("Unknown")).length;
    const covered = [
      ...CLASSIFY.matchAll(/record\.get\("side_count"\)\s*==\s*(\d+)/g),
    ].map((m) => Number(m[1]));
    expect(covered.length).toBeGreaterThan(0);
    expect(covered).not.toContain(sideCount);
  });

  it("no sample names a vendor or customer system", () => {
    // The same scrub `tests/skills/test_evidence_steps.py` runs over the skills, applied to the other
    // text an operator reads. Systems are named by generic role, because this repo publishes
    // publicly — and the modal is the most quoted screen in a demo, so a product name here travels.
    const banned = ["geneva", "duco", "ss&c", "ssnc"];
    for (const s of RECON_SAMPLES) {
      const text = `${s.label} ${s.expectation}`.toLowerCase();
      for (const term of banned)
        expect(text, `${s.label} names ${term}`).not.toContain(term);
    }
  });

  it("withUniqueIds suffixes every item_id without mutating the sample", () => {
    const out = withUniqueIds(RECON_SAMPLES[0].payload, "abc");
    expect(out.items[0].item_id).toMatch(/-abc$/);
    expect(RECON_SAMPLES[0].payload.items[0].item_id).not.toMatch(/-abc$/);
    // The rest of the item must survive the copy — dropping `sides` would still "pass" a suffix
    // check while making the payload meaningless.
    expect(out.items[0].sides).toEqual(RECON_SAMPLES[0].payload.items[0].sides);
  });
});

describe("CUJ scenario coverage", () => {
  const SCENARIOS = [
    "Scenario 1",
    "Scenario 2",
    "Scenario 3",
    "Scenario 4",
    "Scenario 5",
  ];

  it("every CUJ scenario has a sample", () => {
    for (const prefix of SCENARIOS) {
      expect(
        RECON_SAMPLES.some((s) => s.label.startsWith(prefix)),
        `no sample for ${prefix} — the modal is the only place an operator can submit one`,
      ).toBe(true);
    }
  });

  it("the one-sided scenarios zero a side rather than omitting it", () => {
    // A ZEROED side and an ABSENT side reach different code paths: two sides (one zero) matches the
    // side_count == 2 rule and routes to record-match-review, while one side matches no rule at all.
    // The CUJ models a break as line items on both sides, one of which is zero, so these must too.
    for (const prefix of [
      "Scenario 1",
      "Scenario 2",
      "Scenario 4",
      "Scenario 5",
    ]) {
      const sides = sidesOf(sample(prefix));
      expect(sides, `${prefix} must carry both sides`).toHaveLength(2);
      const zeroed = sides.filter((s) => Number(s.attributes?.amount) === 0);
      expect(
        zeroed,
        `${prefix} must have exactly one zero-amount side — that is what makes it that scenario`,
      ).toHaveLength(1);
    }
  });

  it("scenarios 1-4 share a side count, so Tier-1 cannot tell them apart", () => {
    // Asserted POSITIVELY, as known behaviour rather than something to rediscover. BREAK_TYPE_RULES
    // reads only the side count, so all four classify identically; if a future rule keys on WHICH side
    // is zero, this test fails and is the place that explains why the expectations below can change.
    const counts = new Set(SCENARIOS.map((p) => sidesOf(sample(p)).length));
    expect(counts).toEqual(new Set([2]));
  });

  it("each scenario expectation admits that Tier-1 cannot discriminate", () => {
    // Without this the modal implies a discrimination the platform does not make, which is the most
    // likely thing for a demo audience to take away wrongly.
    for (const prefix of SCENARIOS) {
      expect(
        sample(prefix).expectation.toLowerCase(),
        `${prefix} does not mention that Tier-1 cannot distinguish it`,
      ).toMatch(/cannot distinguish|cannot tell|same shape/);
    }
  });

  it("no side attribute key is capitalised", () => {
    // `Currency` next to a lowercase `amount` was harmless — only `amount` is the match attribute — but
    // an operator copying a sample cannot know that, and both the ledger and the notice use lowercase.
    for (const s of RECON_SAMPLES) {
      for (const side of sidesOf(s)) {
        for (const key of Object.keys(side.attributes ?? {})) {
          expect(key, `${s.label} has a capitalised attribute key`).toBe(
            key.toLowerCase(),
          );
        }
      }
    }
  });
});

/**
 * Scenario 5 is the only sample whose resolution is a counterparty email, so it is the only one that
 * keeps `counterparty-contact-draft` on a live path. Its claim rests on three things outside this file
 * — the notice's ground truth, the `amount_type` the mapper derives, and what the break-type skill says
 * to do with it — and each is read here rather than restated, for the reason the header gives: a sample
 * whose claim has quietly stopped being true makes a broken pipeline look validated.
 */
describe("Scenario 5 — the counterparty-email path", () => {
  const NOTICE_BASELINE = join(
    REPO,
    "data/input/idp-evaluation/ground-truth/baseline/02-INTEREST-RATESET",
    "Interest Notice - Global Amount Only.pdf/sections/1/result.json",
  );
  const SKILL = readFileSync(
    join(REPO, "agent-blueprint/recon-agent/skills/record-match-review.md"),
    "utf8",
  );
  const DRAFT_SKILL = readFileSync(
    join(
      REPO,
      "agent-blueprint/recon-agent/skills/counterparty-contact-draft.md",
    ),
    "utf8",
  );

  const attributes = () =>
    sample("Scenario 5").payload.items[0].attributes as Record<string, string>;

  it("matches the notice on the hints the ground truth actually carries", () => {
    // The sample can only reach that notice through fields the extraction really produces. Read from
    // the committed baseline, so a re-extraction that drops one of them fails HERE rather than
    // silently turning the scenario into a no-match.
    const truth = JSON.parse(readFileSync(NOTICE_BASELINE, "utf8"))
      .inference_result as Record<string, string>;
    const attrs = attributes();
    for (const key of [
      "counterparty",
      "fund",
      "facility",
      "value_date",
      "activity_type",
    ])
      expect(attrs[key], `Scenario 5's ${key} is not the notice's`).toBe(
        truth[key],
      );
  });

  it("depends on a notice that has NO fund-level amount", () => {
    // The whole scenario is "the lender's share is absent". A baseline that gained an `amount` would
    // make the agent able to settle it internally, and the email path would go untested again.
    const truth = JSON.parse(readFileSync(NOTICE_BASELINE, "utf8"))
      .inference_result as Record<string, string>;
    expect(truth.amount, "the notice now carries a fund-level amount").toBe(
      undefined,
    );
    expect(truth.global_amount).toBe("418255.00");
  });

  it("turns on an evidence step the skill still names, not a derived label", () => {
    // Anchored on the EVIDENCE STEP, not on a derived label. What Scenario 5 depends on is that the
    // notice carries no fund-level `amount`, so `fund_level_amount_available` is reported unsatisfied
    // and the case cannot settle internally. ⚠️ Do not re-anchor this on a precomputed classification of
    // the amounts: that would need `global_amount`/`fee_amount` read by literal key, and this file
    // would then fail whenever the extraction renamed one, for a reason unrelated to the scenario.
    expect(SKILL).toContain("fund_level_amount_available");
    expect(sample("Scenario 5").expectation).toContain(
      "fund_level_amount_available",
    );
  });

  it("the break-type skill still forbids computing the share itself", () => {
    // If this guidance is ever relaxed the agent would compute an allocation and settle the case, and
    // Scenario 5 would stop being an email scenario — the expectation text would then be wrong.
    // Whitespace-normalised: the skill is hard-wrapped prose, so the sentence spans a line break and
    // a literal substring match would fail on a reflow that changed nothing.
    const prose = SKILL.replace(/\s+/g, " ");
    expect(prose).toContain("Do not compute a share yourself");
    expect(prose).toContain(
      "the allocation is the agent bank's to state, not yours to infer",
    );
  });

  it("the draft skill still routes the ask through submit_proposal's email_draft", () => {
    // The deliverable is a persisted draft, not a send. If the skill ever grows a send tool this
    // sample's expectation ("an `email_draft` ... is the resolution") stops describing the outcome.
    expect(DRAFT_SKILL).toContain("email_draft");
    expect(DRAFT_SKILL).toContain("You have no send tool");
  });

  it("is the only sample that claims an email draft", () => {
    // Not a style rule: if a second sample claimed the path, an operator demoing the email flow would
    // have no way to know which one reliably produces a draft.
    const claiming = RECON_SAMPLES.filter((s) =>
      s.expectation.includes("email_draft"),
    );
    expect(claiming.map((s) => s.label)).toEqual([
      "Scenario 5 — notice states the facility total only",
    ]);
  });
});
