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
    expect(values("按逾期金额的万分之三支付")).toEqual([[3, "‱"]]);
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
