/**
 * The evaluation's questions, shared by the search suite and the live-model
 * runner.
 *
 * `query` is what a model would type into search; `question` is what a reader
 * would ask; `answer` is wording that is on the page(s) that answer it — the
 * right pages are derived from it, never written down by hand, so a question
 * cannot quietly point at the wrong page.
 *
 * Kinds (24.0). The first 36 are single lookups and are what the search suite
 * gates on; the rest were added for the live baseline (review 2026-10-18
 * §2.4), because a set made only of lookups cannot show what a model does when
 * an answer needs several items, several pages, or is not there at all:
 *
 *   lookup     one fact on one page                     `answer`
 *   list       several items, or a table to read        `answers`, `facts`
 *   crossPage  facts from two or more pages             `answers` (one per page), `facts`
 *   none       the document plainly does not say        neither — the right answer is a refusal
 *   scanned    a lookup on a scanned page (OCR text)    `answer`, `facts`
 *
 * `facts` are short strings or numbers a correct answer must state; each is
 * matched after the same normalisation as the wording (case, width, spaces,
 * dashes, quotes, thousands separators), and an array is a set of
 * alternatives, any one of which counts — "三十六个月" and "36个月" are the
 * same fact. Every fact is on a page of the document; a crossPage fact may be
 * the sum or product of two that are.
 *
 * Ids are derived from position within a document and kind, so a recording
 * names its question stably as long as new questions are appended to their
 * group rather than inserted (24.0).
 */
export type QuestionKind = "lookup" | "list" | "crossPage" | "none" | "scanned";

/** A required fact: one string, or alternatives any one of which counts. */
export type Fact = string | string[];

export interface Question {
  /** `<doc>/<kind>-<n>`, assigned below. */
  id: string;
  kind: QuestionKind;
  doc: string;
  query: string;
  question: string;
  /** Wording on the page that answers a lookup or scanned question. */
  answer?: string;
  /** Wordings on each page a list or crossPage answer rests on. */
  answers?: string[];
  facts?: Fact[];
}

type Spec = Omit<Question, "id">;

const LOOKUP: Spec[] = [
  { kind: "lookup", doc: "contract-zh", query: "逾期付款 违约金", question: "甲方如果逾期付款，要承担什么违约责任？", answer: "甲方逾期付款的" },
  { kind: "lookup", doc: "contract-zh", query: "延迟交货 违约责任", question: "乙方延迟交货会怎样？", answer: "乙方逾期交货的" },
  { kind: "lookup", doc: "contract-zh", query: "保修期限", question: "设备的保修期是多久？", answer: "质保期为最终验收合格之日起三十六个月" },
  { kind: "lookup", doc: "contract-zh", query: "付款分几期", question: "合同款分几期付，每期多少？", answer: "本合同价款分三期支付" },
  { kind: "lookup", doc: "contract-zh", query: "故障维修响应时间", question: "设备出故障后，乙方多快必须响应？", answer: "响应时间不超过两小时" },
  { kind: "lookup", doc: "contract-zh", query: "患者隐私 数据", question: "远程维护时对患者数据有什么限制？", answer: "不得复制、存储、传输" },
  { kind: "lookup", doc: "contract-zh", query: "争议 起诉 法院", question: "发生争议时去哪里起诉？", answer: "有管辖权的人民法院提起诉讼" },
  { kind: "lookup", doc: "contract-zh", query: "操作人员培训学时", question: "乙方要给操作人员培训多少学时？", answer: "不少于十六学时" },
  { kind: "lookup", doc: "contract-zh", query: "验收不合格 解除合同", question: "验收不合格时甲方能否解除合同？", answer: "第二次验收仍不合格的" },
  { kind: "lookup", doc: "contract-zh", query: "合同总金额", question: "合同总价是多少？", answer: "合同总价为人民币肆佰叁拾陆万捌仟元整" },
  { kind: "lookup", doc: "contract-zh", query: "不可抗力 通知期限", question: "遇到不可抗力需要在多长时间内通知对方？", answer: "在事件发生后七日内书面通知对方" },
  { kind: "lookup", doc: "contract-zh", query: "开机率", question: "合同对设备开机率有什么要求？", answer: "设备年度开机率应不低于百分之九十五" },
  { kind: "lookup", doc: "contract-zh-rl", query: "逾期付款 违约金", question: "甲方如果逾期付款，要承担什么违约责任？", answer: "甲方逾期付款的" },
  { kind: "lookup", doc: "contract-zh-rl", query: "保修期限", question: "设备的保修期是多久？", answer: "质保期为最终验收合格之日起三十六个月" },
  { kind: "lookup", doc: "contract-zh-rl", query: "争议 起诉 法院", question: "发生争议时去哪里起诉？", answer: "有管辖权的人民法院提起诉讼" },
  { kind: "lookup", doc: "paper-en", query: "memory overhead of the filter", question: "How much memory does the Sieve-A filter use?", answer: "Memory use is fixed" },
  { kind: "lookup", doc: "paper-en", query: "how the sampling rate adapts", question: "How does the sampling rate change over time?", answer: "is doubled (up to 1/8)" },
  { kind: "lookup", doc: "paper-en", query: "cases where admission control hurts", question: "When does admission control not help?", answer: "Two situations defeat the filter" },
  { kind: "lookup", doc: "paper-en", query: "workloads traces used", question: "Which traces were used in the evaluation?", answer: "We use four traces" },
  { kind: "lookup", doc: "paper-en", query: "withdrawn result", question: "Was any earlier result withdrawn, and why?", answer: "has been withdrawn" },
  { kind: "lookup", doc: "paper-en", query: "throughput cost per request", question: "What does the filter cost in throughput?", answer: "per request on the test machine" },
  { kind: "lookup", doc: "paper-en", query: "main results comparison", question: "How does Sieve-A compare with TinyLFU on the main results?", answer: "Table 1 summarises the main result" },
  { kind: "lookup", doc: "gpl-3.0", query: "patent grant from contributors", question: "What patent rights do contributors grant?", answer: "royalty-free patent license under the contributor" },
  { kind: "lookup", doc: "gpl-3.0", query: "warranty disclaimer", question: "Does the license give any warranty?", answer: "THERE IS NO WARRANTY FOR THE PROGRAM" },
  { kind: "lookup", doc: "gpl-3.0", query: "anti-circumvention laws DRM", question: "How does the license treat anti-circumvention laws?", answer: "Protecting Users' Legal Rights From Anti-Circumvention Law" },
  { kind: "lookup", doc: "gpl-3.0", query: "Affero network use", question: "How does GPLv3 interact with the Affero GPL?", answer: "Use with the GNU Affero General Public License" },
  { kind: "lookup", doc: "gpl-3.0", query: "installation information user products", question: "What must be provided as Installation Information for a User Product?", answer: "for a User Product means any methods" },
  { kind: "lookup", doc: "gpl-3.0", query: "terminating the license reinstated", question: "Can a terminated license be reinstated?", answer: "your license from a particular copyright holder is reinstated" },
  { kind: "lookup", doc: "mpl-2.0", query: "license termination breach", question: "What happens to my rights if I breach the MPL?", answer: "will terminate automatically if You fail to comply" },
  { kind: "lookup", doc: "mpl-2.0", query: "who publishes new license versions", question: "Who can publish new versions of the MPL?", answer: "Mozilla Foundation is the license steward" },
  { kind: "lookup", doc: "mpl-2.0", query: "liability limits damages", question: "What does the MPL say about liability for damages?", answer: "Limitation of Liability" },
  { kind: "lookup", doc: "mpl-2.0", query: "distributing source form obligations", question: "What must I do when distributing the Source Code Form?", answer: "Distribution of Source Form" },
  { kind: "lookup", doc: "vicksburg-ocr", query: "shell crater bury a horse", question: "What did the shells do when they landed?", answer: "big enough to bury a horse" },
  { kind: "lookup", doc: "vicksburg-ocr", query: "sewing buttons camp chores", question: "What chores could the soldiers do themselves?", answer: "sew on buttons" },
  { kind: "lookup", doc: "geobase-data-model", query: "document revisions history", question: "What is the revision history of this data model?", answer: "REVISION HISTORY" },
  { kind: "lookup", doc: "geobase-data-model", query: "abbreviation list", question: "What abbreviations does the document define?", answer: "ABBREVIATIONS" },
];

// Several items, or a table read across (24.0). Items in a table are matched
// as cells, so no wording below spans a `|`.
const LIST: Spec[] = [
  { kind: "list", doc: "contract-zh", query: "采购设备 清单", question: "这份合同采购了哪些设备？", answers: ["数字化 X 射线摄影系统", "移动式 C 形臂", "医用干式激光相机", "影像工作站及软件授权"], facts: ["X 射线摄影系统", "C 形臂", "激光相机", "影像工作站"] },
  { kind: "list", doc: "contract-zh", query: "付款 比例 金额", question: "三期付款的条件、比例和金额分别是什么？", answers: ["本合同价款分三期支付"], facts: ["30%", "60%", "10%", ["1,310,400", "131.04万"], ["2,620,800", "262.08万"], ["436,800", "43.68万"]] },
  { kind: "list", doc: "contract-zh", query: "交付 提交 资料", question: "交付设备时乙方必须一并提交哪些资料？", answers: ["产品合格证、医疗器械注册证复印件"], facts: ["产品合格证", "医疗器械注册证", "中文使用说明书", "维修手册", "装箱清单"] },
  { kind: "list", doc: "contract-zh", query: "合同附件", question: "合同包括哪几个附件？", answers: ["附件一《设备清单及配置》"], facts: ["设备清单及配置", "技术参数响应表", "售后服务承诺书"] },
  { kind: "list", doc: "contract-zh", query: "价格包含 费用", question: "合同总价包含了哪些费用？", answers: ["该价格已包含设备费"], facts: ["设备费", "运输费", "保险费", "安装调试费", "培训费"] },
  { kind: "list", doc: "contract-zh", query: "响应时间 到场时间", question: "合同对故障响应和到场分别规定了哪些时限？", answers: ["到场时间不超过六小时"], facts: [["两小时", "2小时", "2 个小时"], ["六小时", "6小时", "6 个小时"], ["八小时", "8小时", "8 个小时"]] },
  { kind: "list", doc: "contract-zh", query: "培训 学时", question: "乙方要提供哪两类培训，各多少学时？", answers: ["不少于八学时的日常维护培训"], facts: [["十六学时", "16学时", "16 个学时"], ["八学时", "8学时", "8 个学时"]] },
  { kind: "list", doc: "contract-zh", query: "不可抗力 情形", question: "合同列举了哪些不可抗力情形？", answers: ["因地震、台风、洪水、战争、政府行为"], facts: ["地震", "台风", "洪水", "战争", "政府行为"] },
  { kind: "list", doc: "contract-zh-rl", query: "设备 型号", question: "采购的各台设备型号分别是什么？", answers: ["HY-DR 760", "HY-C 310", "HY-LP 22", "HY-WS 9"], facts: ["HY-DR 760", "HY-C 310", "HY-LP 22", "HY-WS 9"] },
  { kind: "list", doc: "contract-zh-rl", query: "设备 单价 数量", question: "每种设备买了几台（套），单价各是多少？", answers: ["1,280,000.00", "1,150,000.00", "146,000.00", "55,000.00"], facts: [["1,280,000", "128万"], ["1,150,000", "115万"], ["146,000", "14.6万"], ["55,000", "5.5万"]] },
  { kind: "list", doc: "paper-en", query: "Table 1 Sieve-A byte miss ratio", question: "What byte miss ratio does Table 1 report for Sieve-A on each trace?", answers: ["35.4", "44.6"], facts: ["35.4", "19.7", "22.4", "44.6"] },
  { kind: "list", doc: "paper-en", query: "baseline policies compared", question: "Which policies is Sieve-A evaluated against?", answers: ["we evaluate it against LRU, ARC and a TinyLFU-style frequency sketch"], facts: ["LRU", "ARC", "TinyLFU"] },
  { kind: "list", doc: "paper-en", query: "three claims", question: "What three claims does the paper make?", answers: ["We make three claims"], facts: ["0.9", ["fixed memory budget", "fixed memory"], "4 KiB"] },
  { kind: "list", doc: "paper-en", query: "cache capacity settings", question: "Which cache capacities were the traces run at, and how many times each?", answers: ["Cache capacity is set to 1%, 2% and 5%"], facts: ["1%", "2%", "5%", ["five times", "5 times"]] },
  { kind: "list", doc: "paper-en", query: "Table 1 LRU column", question: "What byte miss ratios does Table 1 give for LRU on the four traces?", answers: ["41.2", "45.8"], facts: ["41.2", "27.6", "33.0", "45.8"] },
  { kind: "list", doc: "gpl-3.0", query: "conveying object code ways", question: "In what ways does section 6 allow object code to be conveyed?", answers: ["Conveying Non-Source Forms"], facts: ["physical product", "written offer", "network server", "peer-to-peer"] },
  { kind: "list", doc: "gpl-3.0", query: "modified source version conditions", question: "What conditions must a modified source version meet under section 5?", answers: ["The work must carry prominent notices stating that you modified it"], facts: ["prominent notices", "relevant date", "released under this License", "entire work"] },
  { kind: "list", doc: "mpl-2.0", query: "definitions", question: "Which terms does section 1 of the MPL define?", answers: ["\"Executable Form\" means any form of the work other than Source Code Form"], facts: ["Contributor", "Covered Software", "Executable Form", "Larger Work", "Modifications", "Secondary License", "Source Code Form"] },
  { kind: "list", doc: "mpl-2.0", query: "Secondary License means", question: "Which licences count as a \"Secondary License\" under the MPL?", answers: ["\"Secondary License\" means either the GNU General Public License"], facts: [["Lesser General Public", "LGPL"], ["Affero", "AGPL"], "2.1", "3.0"] },
  { kind: "list", doc: "mpl-2.0", query: "patent license limitations", question: "For which code or infringements does the MPL grant no patent license?", answers: ["for any code that a Contributor has removed from Covered Software"], facts: ["removed", ["modifications of Covered Software", "modification"], ["combination", "combinations"]] },
  { kind: "list", doc: "geobase-data-model", query: "revision history dates versions", question: "List every entry of the revision history with its date and version.", answers: ["REVISION HISTORY"], facts: ["September 2002", "January 2003", "March 2003", "July 2003", "December 2003", "February 2004", "May 2004", "August 2004", "2004.1"] },
  { kind: "list", doc: "geobase-data-model", query: "packages constitute NHNC1", question: "Which packages make up the NHNC1 LRS model?", answers: ["Four packages constitute the NHNC1"], facts: ["Hydro Network", "Hydrographic", ["Hydro Events", "Hydro Event"], "Metadata"] },
  { kind: "list", doc: "geobase-data-model", query: "obstacle type code list", question: "What values does the CL_Obstacle Type code list define?", answers: ["Exposed shipwreck = 6"], facts: ["Falls", "Rapids", "Reef", "Rocks", "Disappearing stream", "Exposed shipwreck", "Ford"] },
  { kind: "list", doc: "geobase-data-model", query: "manmade type code list", question: "Which man-made feature types are listed in CL_Manmade Type?", answers: ["Lock Gate = 6"], facts: ["Dam", "Dock", "Wharf", "Breakwater", "Dike/Levee", "Lock Gate", "Boat Ramp", "Fish Ladder", "Slip"] },
  { kind: "list", doc: "geobase-data-model", query: "table of contents sections", question: "Which subsections of 3.1 does the table of contents list?", answers: ["TABLE OF CONTENTS"], facts: ["Logical view", "Hydro network", "Hydro events", "Hydrographic", "Toponymy", "Metadata"] },
  { kind: "list", doc: "geobase-data-model", query: "feature type code list", question: "What values does the CL_Feature Type code list contain?", answers: ["MarineWaterbody = 1"], facts: ["MarineWaterbody", "FaultLine", "Landscape", "MassIce", "Mountains", "ProjectionOfLand", "UnderseaFeature", "InlandWater"] },
];

// Facts from two or more pages (24.0): one wording per page, and the right
// answer cites every one of them.
const CROSS_PAGE: Spec[] = [
  { kind: "crossPage", doc: "contract-zh", query: "违约金 合同总价 百分之二十", question: "第二次验收仍不合格，和乙方逾期交货超过三十日，这两种情况的违约金各按什么计算？", answers: ["第二次验收仍不合格的", "逾期超过三十日"], facts: [["百分之二十", "20%"]] },
  { kind: "crossPage", doc: "contract-zh", query: "合同总价 第二期付款", question: "合同总价是多少？第二期付款的比例和金额是多少？", answers: ["合同总价为人民币肆佰叁拾陆万捌仟元整", "最终验收合格并签署验收报告后三十日内"], facts: [["4,368,000", "肆佰叁拾陆万捌仟", "436.8万"], "60%", ["2,620,800", "262.08万"]] },
  { kind: "crossPage", doc: "contract-zh", query: "患者数据 违约金 合同总价", question: "乙方违反患者数据保护条款，要付多少钱的违约金？请算出金额。", answers: ["按合同总价的百分之十支付违约金", "合同总价为人民币肆佰叁拾陆万捌仟元整"], facts: [["百分之十", "10%"], ["436,800", "43.68万"]] },
  { kind: "crossPage", doc: "contract-zh", query: "逾期 违约金 比例", question: "甲方逾期付款和乙方逾期交货，每逾期一日的违约金比例分别是多少？", answers: ["甲方逾期付款的", "乙方逾期交货的"], facts: ["万分之三", "千分之一"] },
  { kind: "crossPage", doc: "contract-zh", query: "培训学时 开机率", question: "合同对操作人员培训学时和设备年度开机率分别有什么要求？", answers: ["不少于十六学时", "设备年度开机率应不低于百分之九十五"], facts: [["十六学时", "16学时", "16 个学时"], ["百分之九十五", "95%"]] },
  { kind: "crossPage", doc: "contract-zh-rl", query: "合同编号 签订日期", question: "这份合同的编号是什么？双方签字的日期是哪天？", answers: ["合同编号", "日期：2025 年 4 月 17 日"], facts: ["PW-EVAL-2025-0417", ["2025年4月17日", "2025-04-17"]] },
  { kind: "crossPage", doc: "contract-zh-rl", query: "交货期限 质保期", question: "乙方要在多长时间内交货？质保期从什么时候算起、多长？", answers: ["四十五日内将全部设备运抵", "质保期为最终验收合格之日起三十六个月"], facts: [["四十五日", "45日", "45天"], ["三十六个月", "36个月"]] },
  { kind: "crossPage", doc: "paper-en", query: "7.4% average improvement definition", question: "The abstract claims 7.4% on average and up to 18.9%. How are those two numbers defined in the results?", answers: ["lowers the byte miss ratio by 7.4% on average", "The averaged improvement of 7.4% quoted in the abstract"], facts: ["ARC", "CDN", "1%"] },
  { kind: "crossPage", doc: "paper-en", query: "16 KiB metadata breakdown", question: "The abstract says Sieve-A uses 16 KiB of metadata. How is that figure made up?", answers: ["16 KiB of metadata per million cached objects", "Memory use is fixed"], facts: ["8 KiB", "1,024", "8 bytes"] },
  { kind: "crossPage", doc: "paper-en", query: "negative results MIX size class", question: "What negative results does the abstract mention, and why does the filter fail on MIX?", answers: ["We also report two negative results", "a single size class may contain both a 40-byte session token"], facts: ["40-byte", "3 KiB"] },
  { kind: "crossPage", doc: "paper-en", query: "doubling size classes trade-off", question: "What happened when the authors doubled the number of size classes?", answers: ["We tried doubling the number of size classes", "recovered about half of the loss"], facts: ["half", "doubled the memory"] },
  { kind: "crossPage", doc: "gpl-3.0", query: "definitions propagate convey", question: "Which terms does section 0 of the GPL define?", answers: ["0. Definitions.", "To \"propagate\" a work means"], facts: ["This License", "Copyright", "The Program", "modify", "covered work", "propagate", "convey"] },
  { kind: "crossPage", doc: "gpl-3.0", query: "additional terms permitted", question: "Which additional terms may be added to material under section 7?", answers: ["Disclaiming warranty or limiting liability differently", "Requiring indemnification of licensors and authors"], facts: ["warranty", "legal notices", "misrepresentation", "publicity", "trademark", "indemnification"] },
  { kind: "crossPage", doc: "gpl-3.0", query: "warranty liability interpretation", question: "What do the warranty disclaimer and limitation of liability say, and how are they interpreted where they cannot take effect?", answers: ["THERE IS NO WARRANTY FOR THE PROGRAM", "Interpretation of Sections 15 and 16"], facts: ["AS IS", "local law"] },
  { kind: "crossPage", doc: "mpl-2.0", query: "Executable Form distribution conditions", question: "What must I do when distributing Covered Software in Executable Form?", answers: ["Distribution of Executable Form If You distribute Covered Software in Executable Form", "You may distribute such Executable Form under the terms of this License"], facts: ["Source Code Form", ["reasonable means", "reasonable"], "sublicense"] },
  { kind: "crossPage", doc: "geobase-data-model", query: "validity_date object metadata", question: "The revision history mentions renaming \"date\" to \"validity_date\". What attributes does the Object Metadata class have?", answers: ["in section 3.1.6.2 and at all other parts", "3.1.6.2 Object Metadata"], facts: ["validity_date", "acquisitionTechnique", "datasetName", "planimetricAccuracy", "provider", "completelyCover"] },
  { kind: "crossPage", doc: "geobase-data-model", query: "inland water feature type", question: "The revision history says a feature type value was added for inland water. Which value is it in the code list?", answers: ["A new Feature type value is added for inland water", "InlandWater = 8"], facts: ["InlandWater", "8"] },
];

// The document plainly does not say (24.0). A good answer says so and cites
// nothing as the answer.
const NONE: Spec[] = [
  { kind: "none", doc: "contract-zh", query: "乙方 法定代表人 姓名", question: "乙方的法定代表人叫什么名字？" },
  { kind: "none", doc: "contract-zh", query: "电源 功率 要求", question: "设备对电源功率有什么要求？" },
  { kind: "none", doc: "contract-zh", query: "注册资本", question: "合同对乙方的注册资本有什么要求？" },
  { kind: "none", doc: "contract-zh-rl", query: "医院 床位数", question: "这家医院有多少张床位？" },
  { kind: "none", doc: "paper-en", query: "test machine CPU model", question: "Which CPU model did the test machine use?" },
  { kind: "none", doc: "paper-en", query: "video streaming trace results", question: "How does Sieve-A perform on a video streaming trace?" },
  { kind: "none", doc: "paper-en", query: "authors affiliations", question: "Who are the authors of the paper, and where do they work?" },
  { kind: "none", doc: "gpl-3.0", query: "court jurisdiction disputes", question: "Which court has jurisdiction over disputes under the GPL?" },
  { kind: "none", doc: "gpl-3.0", query: "FSF president", question: "Who is the president of the Free Software Foundation?" },
  { kind: "none", doc: "mpl-2.0", query: "Mozilla postal address", question: "What is the Mozilla Foundation's postal address?" },
  { kind: "none", doc: "geobase-data-model", query: "total length rivers kilometres", question: "What is the total length of rivers in the National Hydro Network, in kilometres?" },
  { kind: "none", doc: "geobase-data-model", query: "coordinate reference system datum", question: "Which datum and coordinate reference system does the data model use?" },
  { kind: "none", doc: "vicksburg-ocr", query: "author name", question: "What is the name of the soldier who wrote this diary?" },
  { kind: "none", doc: "vicksburg-ocr", query: "June 13 casualties", question: "How many Union soldiers were killed on June 13th?" },
  { kind: "none", doc: "vicksburg-ocr", query: "price of mule meat", question: "What was the price of mule meat in Vicksburg?" },
];

// Lookups on the real scan, read through its OCR text layer (24.0). The
// wordings are as recognised, misspellings included — that is the text a
// model is given and the text its quotes are checked against.
const SCANNED: Spec[] = [
  { kind: "scanned", doc: "vicksburg-ocr", query: "Johnston coming raise the siege", question: "What report about Johnston reached the camp?", answer: "Johnston is coming with fifty thousand men", facts: [["fifty thousand", "50,000"]] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "building bunks cane", question: "How did the soldiers improve their quarters on June 10th?", answer: "cutting cane and building bunks", facts: ["cane", "bunks"] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "mortar shells in the air at once", question: "How many mortar shells did the writer see in the air at once?", answer: "as many as three of them in the air at once", facts: [["three", "3"]] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "inhabitants living caves", question: "Where were the inhabitants of Vicksburg living, according to prisoners?", answer: "living in caves dug out of the sides of the hills", facts: ["caves"] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "mortar silenced guns", question: "What silenced the rebel mortar on June 11th?", answer: "a hundred guns around our line soon roared the mortar to silence", facts: [["a hundred guns", "100 guns", "hundred guns"]] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "96th Ohio friend bullet", question: "What happened to the writer's friend from the 96th Ohio?", answer: "A friend from the 96th Ohio", facts: ["arm"] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "pay a month dollars", question: "How much pay a month did a soldier draw?", answer: "thirteen dollars a month", facts: [["thirteen dollars", "$13", "13 dollars"]] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "term of enlistment left", question: "How much of their term of enlistment did the soldiers have left?", answer: "but a year left of the term of our enlistment", facts: [["a year", "one year"]] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "court house flag", question: "What flag was flying from the court house at Vicksburg?", answer: "There is a Confederate flag waving from it defiantly", facts: ["Confederate flag"] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "canister shot tin cylinder", question: "How is canister shot made?", answer: "Cannister shot is a tin cylinder with iron heads", facts: ["tin cylinder", ["saw-dust", "sawdust"]] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "grape shot balls in a bed", question: "How many balls of grape shot lie in one bed?", answer: "seven of them can lie in a bed", facts: [["seven", "7"]] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "catch phrases eastern army", question: "What catch phrases did the Western boys hear about the eastern army?", answer: "All Quiet on the Potomac", facts: ["Bull Run", "Rappahannock", "All Quiet on the Potomac"] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "oxen haul siege guns", question: "How many oxen did it take to haul each siege gun?", answer: "ten yoke of oxen", facts: [["ten yoke", "10 yoke"]] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "siege guns calibre length", question: "What were the calibre and length of the siege guns?", answer: "These guns are nine-inch calibre", facts: [["nine-inch", "9-inch", "9 in"], ["twelve feet", "12 feet", "12 ft"]] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "general inspection Sunday", question: "When was general inspection, and what did the officers find?", answer: "Sunday is general inspection day", facts: [["10 A. M.", "10 a.m.", "10 am", "ten o'clock"], ["bright and clean", "clean"]] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "hard tack tossed Fort Hill", question: "What was tossed into Fort Hill?", answer: "a hard tack was tossed into it", facts: ["hard tack"] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "wounded returned Raymond", question: "Where had the returning wounded boys been wounded?", answer: "Some of the boys wounded at Raymond", facts: ["Raymond"] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "guard rebel prisoners corral", question: "What duty was the writer given on June 17th?", answer: "guard rebel prisoners in the corral at Logan's headquarters", facts: ["prisoners", "Logan"] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "projectile expanding wad", question: "What is the expanding portion of the projectile made of?", answer: "papier-mache wad", facts: [["papier-mache", "papier-mâché", "papier mache"]] },
  { kind: "scanned", doc: "vicksburg-ocr", query: "garrison mule meat rations", question: "What were the garrison's rations, according to the prisoners?", answer: "mule meat and scanty meal rations", facts: ["mule meat"] },
];

function withIds(specs: Spec[]): Question[] {
  const seen = new Map<string, number>();
  return specs.map((q) => {
    const key = `${q.doc}/${q.kind}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { id: `${key}-${String(n).padStart(2, "0")}`, ...q };
  });
}

export const QUESTIONS: Question[] = withIds([...LOOKUP, ...LIST, ...CROSS_PAGE, ...NONE, ...SCANNED]);

/** The wordings whose pages a right answer cites: one per page it rests on. */
export function answerWordings(q: Pick<Question, "answer" | "answers">): string[] {
  return q.answers ?? (q.answer ? [q.answer] : []);
}

/**
 * The normalisation every wording and fact is matched under: width and case
 * folded, and spaces, dashes, quotes and thousands separators dropped — a
 * model writing "1310400" or "36 个月" has stated the same thing as the page.
 */
export const squashFact = (s: string): string =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(\d),(?=\d{3})/g, "$1")
    .replace(/[\s\-­‐-—'"‘’“”]/g, "");
