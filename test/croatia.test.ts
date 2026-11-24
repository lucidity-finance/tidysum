import Big from "big.js";
import { describe, expect, it } from "vitest";
import {
  croatiaOwnerCheck,
  incomeTax,
  obrtYear,
  parseCroatiaOwner,
} from "../src/croatia/ownerCheck.js";
import { HR_RULES_2026 } from "../src/croatia/rules.js";

const x = {
  r: HR_RULES_2026,
  lower: new Big("0.23"),
  higher: new Big("0.33"),
  bracket: new Big("60000"),
  allowance: new Big("7200"),
  minBase: new Big("1295.45"),
  maxBase: new Big("11958.00"),
};

const base = { tax_year: 2026, as_of: "2026-11-24" };

describe("Croatian income tax", () => {
  it("applies the allowance, then Zagreb's 23% up to 60,000 and 33% above", () => {
    expect(incomeTax(new Big(7000), x).toFixed(2)).toBe("0.00");
    expect(incomeTax(new Big(17200), x).toFixed(2)).toBe("2300.00");
    // 80,000 taxable: 60,000 x 23% + 20,000 x 33%.
    expect(incomeTax(new Big(87200), x).toFixed(2)).toBe("20400.00");
  });
});

describe("obrt dohodaš contributions", () => {
  it("follow income between the minimum and maximum base, and are deducted from it", () => {
    const mid = obrtYear(new Big(136500), x);
    expect(mid.contributions.toFixed(2)).toBe("36500.00");
    expect(mid.income.toFixed(2)).toBe("100000.00");
    expect(mid.pension.toFixed(2)).toBe("20000.00");

    // Little profit: the minimum base, 1,295.45 a month (the 2026 JOPPD amounts).
    const low = obrtYear(new Big(5000), x);
    expect(low.contributions.div(12).toFixed(2)).toBe("472.84");

    // A lot of profit: capped at the maximum base.
    const high = obrtYear(new Big(500000), x);
    expect(high.contributions.toFixed(2)).toBe(
      new Big("11958").times(12).times("0.365").toFixed(2),
    );
  });
});

describe("croatia owner check", () => {
  it("prices billing obrt work through the company, keeping the obrt's allowance used", () => {
    const r = croatiaOwnerCheck(
      parseCroatiaOwner({
        ...base,
        obrt: { profit: "120000" },
        company: { revenue: "60000", profit: "50000" },
      }),
    );
    expect(r.current?.owner_net).toBe("106877.10");
    const billing = r.findings.find((f) => f.kind === "billing");
    expect(billing?.annual_cost).toBe("24759.47");
    // The obrt keeps about enough income to use the personal allowance, nothing taxed above it.
    expect(billing?.inputs.shifted).toBe("106800.00");
    expect(new Big(billing?.inputs.pension_contributions_forgone ?? 0).gt(0)).toBe(true);
    expect(r.findings.some((f) => f.kind === "owner_pay")).toBe(false);
  });

  it("finds a salary costs more than dividends once the obrt uses the allowance", () => {
    const r = croatiaOwnerCheck(
      parseCroatiaOwner({
        ...base,
        obrt: { profit: "40000" },
        company: { revenue: "80000", profit: "60000", owner_salary: "24000" },
      }),
    );
    const pay = r.findings.find((f) => f.kind === "owner_pay");
    expect(pay?.inputs.salary_best).toBe("0.00");
    expect(new Big(pay?.annual_cost ?? 0).gt(1000)).toBe(true);
  });

  it("uses the higher profit tax above EUR 1,000,000 of revenue", () => {
    const r = croatiaOwnerCheck(
      parseCroatiaOwner({ ...base, company: { revenue: "1200000", profit: "100000" } }),
    );
    expect(r.current?.profit_tax).toBe("18000.00");
    expect(r.current?.dividend_tax).toBe("9840.00");
  });

  it("prices idle company cash after profit tax, and the unused III. stup incentive", () => {
    const r = croatiaOwnerCheck(
      parseCroatiaOwner({
        ...base,
        company: { revenue: "50000", profit: "0", cash: "40000", cash_buffer: "10000" },
        benchmark_rate: "0.02",
        pillar3_contributed: "300",
      }),
    );
    expect(r.findings.find((f) => f.kind === "company_cash")?.annual_cost).toBe("540.00");
    expect(r.findings.find((f) => f.kind === "pillar3")?.annual_cost).toBe("54.54");
  });

  it("warns when company cash can't be priced", () => {
    const r = croatiaOwnerCheck(
      parseCroatiaOwner({ ...base, company: { revenue: "1", profit: "0", cash: "5000" } }),
    );
    expect(r.warnings.join(" ")).toMatch(/benchmark_rate/);
  });

  it("lists gains still inside the two-year window, soonest first", () => {
    const r = croatiaOwnerCheck(
      parseCroatiaOwner({
        ...base,
        lots: [
          { name: "B", acquired: "2025-06-02", cost: "1000", value: "1500" },
          { name: "A", acquired: "2025-01-10", cost: "1000", value: "1200" },
          { name: "old", acquired: "2023-01-10", cost: "1000", value: "3000" },
          { name: "loss", acquired: "2026-01-10", cost: "1000", value: "900" },
        ],
      }),
    );
    expect(r.holding_periods.map((h) => h.name)).toEqual(["A", "B"]);
    expect(r.holding_periods[1]).toMatchObject({
      tax_if_sold_now: "60.00",
      tax_free_from: "2027-06-03",
    });
  });

  it("falls back to the newest rules for another year, with a warning", () => {
    const r = croatiaOwnerCheck(parseCroatiaOwner({ ...base, tax_year: 2027 }));
    expect(r.rules.year).toBe(2026);
    expect(r.warnings.join(" ")).toMatch(/2027/);
  });

  it("rejects floats and unknown fields", () => {
    expect(() => parseCroatiaOwner({ ...base, obrt: { profit: 120000 } })).toThrow(/obrt.profit/);
    expect(() => parseCroatiaOwner({ ...base, extra: 1 })).toThrow();
  });

  describe("dividends across borders", () => {
    const lots = [
      { name: "US ETF", value: "20000", domicile: "US", kind: "fund", dividend_yield: "0.013" },
      {
        name: "Irish world, distributing",
        value: "30000",
        domicile: "IE",
        kind: "fund",
        distributing: true,
        dividend_yield: "0.018",
        us_share: "0.6",
      },
      {
        name: "Irish world, accumulating",
        value: "30000",
        domicile: "IE",
        kind: "fund",
        distributing: false,
        dividend_yield: "0.018",
        us_share: "0.6",
      },
    ];

    it("prices the US's 30% and Croatia's 12% against an Irish accumulating fund", () => {
      const r = croatiaOwnerCheck(parseCroatiaOwner({ ...base, lots }), { investing: true });
      const by = Object.fromEntries(
        r.findings.filter((f) => f.kind === "dividend_tax").map((f) => [f.key, f.annual_cost]),
      );
      // 20,000 x 1.3% x (30% - 15%).
      expect(by["hr:dividend_tax:US ETF"]).toBe("39.00");
      // 30,000 x 1.8% x ((1 - 0.91 x 0.88) - 0.6 x 15%).
      expect(by["hr:dividend_tax:Irish world, distributing"]).toBe("58.97");
      expect(by["hr:dividend_tax:Irish world, accumulating"]).toBeUndefined();
    });

    it("warns about US estate tax on US assets near USD 60,000", () => {
      const big = [{ name: "US stocks", value: "50000", domicile: "US", kind: "stock" }];
      const r = croatiaOwnerCheck(parseCroatiaOwner({ ...base, lots: big }), { investing: true });
      expect(r.warnings.join(" ")).toMatch(/estate|at death/);
      const over = croatiaOwnerCheck(
        parseCroatiaOwner({ ...base, lots: [{ ...big[0], value: "60000" }], usd_per_eur: "1.10" }),
        { investing: true },
      );
      expect(over.warnings.join(" ")).toMatch(/USD 66000.00/);
      const under = croatiaOwnerCheck(
        parseCroatiaOwner({ ...base, lots: [{ ...big[0], value: "30000" }], usd_per_eur: "1.10" }),
        { investing: true },
      );
      expect(under.warnings).toEqual([]);
    });

    it("stays off without investing enabled", () => {
      const r = croatiaOwnerCheck(parseCroatiaOwner({ ...base, lots }));
      expect(r.findings).toEqual([]);
      expect(r.warnings.join(" ")).toMatch(/investing/);
    });
  });
});
