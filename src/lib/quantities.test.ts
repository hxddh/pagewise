import { describe, expect, it } from "vitest";
import { chineseNumeral, quantities, unstatedQuantities } from "./quantities";

const values = (s: string) => quantities(s).map((q) => [q.value, q.kind]);

describe("chineseNumeral", () => {
  it("reads lower and upper case, with 万", () => {
    expect(chineseNumeral("三十六")).toBe(36);
    expect(chineseNumeral("十")).toBe(10);
    expect(chineseNumeral("七十二")).toBe(72);
    expect(chineseNumeral("肆佰叁拾陆万捌仟")).toBe(4_368_000);
    expect(chineseNumeral("一千二百")).toBe(1200);
    expect(chineseNumeral("统一")).toBeNull();
  });
});

describe("quantities", () => {
  it("reads the spellings a contract uses", () => {
    expect(values("质保期为最终验收合格之日起三十六个月")).toEqual([[36, ""]]);
    expect(values("按逾期金额的万分之三支付")).toEqual([[0.03, "%"]]);
    expect(values("预付百分之三十，即 1,310,400.00 元")).toEqual([[30, "%"], [1310400, ""]]);
    expect(values("合同总价为人民币肆佰叁拾陆万捌仟元整")).toEqual([[4368000, ""]]);
    expect(values("Memory use is fixed at 12.5% of the cache")).toEqual([[12.5, "%"]]);
  });

  it("leaves words that only look like numbers alone", () => {
    expect(values("甲乙双方统一意见，任何一方不得")).toEqual([]);
    expect(values("第三方")).toEqual([]);
  });

  it("does not read page references", () => {
    expect(values("As page 12 says, and p. 14 repeats")).toEqual([]);
    expect(values("见第 12 页")).toEqual([]);
  });
});

describe("unstatedQuantities", () => {
  const passage = "质保期为最终验收合格之日起三十六个月。甲方逾期付款的，每逾期一日按逾期金额的万分之三向乙方支付违约金，合同总价为人民币肆佰叁拾陆万捌仟元整。";

  it("accepts the same number in another spelling or unit", () => {
    expect(unstatedQuantities("质保期是 36 个月", passage)).toEqual([]);
    expect(unstatedQuantities("质保期三年", passage)).toEqual([]);
    expect(unstatedQuantities("The warranty runs 3 years", passage)).toEqual([]);
    expect(unstatedQuantities("合同总价 436.8 万元", passage)).toEqual([]);
    expect(unstatedQuantities("合同总价 4,368,000 元", passage)).toEqual([]);
    expect(unstatedQuantities("违约金为每日万分之三", passage)).toEqual([]);
  });

  it("names the number the passage does not state", () => {
    expect(unstatedQuantities("质保期是 24 个月", passage).map((q) => q.text)).toEqual(["24"]);
    expect(unstatedQuantities("违约金为每日千分之三", passage).map((q) => q.text)).toEqual(["千分之三"]);
    expect(unstatedQuantities("质保期两年", passage).map((q) => q.value)).toEqual([2]);
  });

  it("has nothing to say about a sentence without numbers", () => {
    expect(unstatedQuantities("乙方负责维修", passage)).toEqual([]);
  });
});

describe("16.0: spellings 15.0 read wrong", () => {
  const ok = (claim: string, passage: string) => expect(unstatedQuantities(claim, passage).map((q) => q.text)).toEqual([]);

  it("B3: 万 after 亿 is part of the numeral", () => {
    expect(chineseNumeral("一亿五千万")).toBe(150_000_000);
    ok("金额为一亿五千万元", "金额为150,000,000元");
    ok("金额为1.5亿元", "金额为一亿五千万元");
    ok("合同价肆佰叁拾陆万捌仟元", "合同价4,368,000元");
  });

  it("B4: a year written digit by digit", () => {
    expect(chineseNumeral("二〇二五")).toBe(2025);
    ok("于二〇二五年生效", "于2025年生效");
  });

  it("B5: per mille and per ten thousand are percentages", () => {
    ok("费率为万分之三", "费率为0.03%");
    ok("rate of 0.3%", "按千分之三计");
    expect(unstatedQuantities("费率为千分之三", "费率为万分之三").map((q) => q.text)).toEqual(["千分之三"]);
  });

  it("B5: percent spelled as a word", () => {
    ok("a 30 percent deposit", "定金为30%");
    ok("a 30 per cent deposit", "定金为百分之三十");
  });

  it("B5: a bare 万 or 亿 scales the number", () => {
    ok("罚款131.04万", "罚款1,310,400元");
    ok("5万", "50,000");
    ok("5万元", "50000");
    expect(unstatedQuantities("罚款13.04万", "罚款1,310,400元").map((q) => q.text)).toEqual(["13.04万"]);
  });

  it("B5: halves and quarters", () => {
    ok("保修6个月", "保修半年");
    ok("期限一年半", "期限18个月");
    ok("每3个月结算", "每一个季度结算");
    expect(unstatedQuantities("保修9个月", "保修半年").map((q) => q.text)).toEqual(["9"]);
  });

  it("B5: clause and section numbers are not quantities", () => {
    expect(values("见第9.2款")).toEqual([]);
    expect(values("按第十二条执行")).toEqual([]);
    expect(values("See Section 12.3 and clause 4")).toEqual([]);
  });
});
