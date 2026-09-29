/**
 * The evaluation's questions, shared by the search suite and the live-model
 * runner.
 *
 * `query` is what a model would type into search; `question` is what a reader
 * would ask; `answer` is wording that is on the page(s) that answer it — the
 * right pages are derived from it, never written down by hand, so a question
 * cannot quietly point at the wrong page.
 */
export interface Question {
  doc: string;
  query: string;
  question: string;
  answer: string;
}

export const QUESTIONS: Question[] = [
  { doc: "contract-zh", query: "逾期付款 违约金", question: "甲方如果逾期付款，要承担什么违约责任？", answer: "甲方逾期付款的" },
  { doc: "contract-zh", query: "延迟交货 违约责任", question: "乙方延迟交货会怎样？", answer: "乙方逾期交货的" },
  { doc: "contract-zh", query: "保修期限", question: "设备的保修期是多久？", answer: "质保期为最终验收合格之日起三十六个月" },
  { doc: "contract-zh", query: "付款分几期", question: "合同款分几期付，每期多少？", answer: "本合同价款分三期支付" },
  { doc: "contract-zh", query: "故障维修响应时间", question: "设备出故障后，乙方多快必须响应？", answer: "响应时间不超过两小时" },
  { doc: "contract-zh", query: "患者隐私 数据", question: "远程维护时对患者数据有什么限制？", answer: "不得复制、存储、传输" },
  { doc: "contract-zh", query: "争议 起诉 法院", question: "发生争议时去哪里起诉？", answer: "有管辖权的人民法院提起诉讼" },
  { doc: "contract-zh", query: "操作人员培训学时", question: "乙方要给操作人员培训多少学时？", answer: "不少于十六学时" },
  { doc: "contract-zh", query: "验收不合格 解除合同", question: "验收不合格时甲方能否解除合同？", answer: "第二次验收仍不合格的" },
  { doc: "contract-zh", query: "合同总金额", question: "合同总价是多少？", answer: "合同总价为人民币肆佰叁拾陆万捌仟元整" },
  { doc: "contract-zh", query: "不可抗力 通知期限", question: "遇到不可抗力需要在多长时间内通知对方？", answer: "在事件发生后七日内书面通知对方" },
  { doc: "contract-zh", query: "开机率", question: "合同对设备开机率有什么要求？", answer: "设备年度开机率应不低于百分之九十五" },
  { doc: "contract-zh-rl", query: "逾期付款 违约金", question: "甲方如果逾期付款，要承担什么违约责任？", answer: "甲方逾期付款的" },
  { doc: "contract-zh-rl", query: "保修期限", question: "设备的保修期是多久？", answer: "质保期为最终验收合格之日起三十六个月" },
  { doc: "contract-zh-rl", query: "争议 起诉 法院", question: "发生争议时去哪里起诉？", answer: "有管辖权的人民法院提起诉讼" },
  { doc: "paper-en", query: "memory overhead of the filter", question: "How much memory does the Sieve-A filter use?", answer: "Memory use is fixed" },
  { doc: "paper-en", query: "how the sampling rate adapts", question: "How does the sampling rate change over time?", answer: "is doubled (up to 1/8)" },
  { doc: "paper-en", query: "cases where admission control hurts", question: "When does admission control not help?", answer: "Two situations defeat the filter" },
  { doc: "paper-en", query: "workloads traces used", question: "Which traces were used in the evaluation?", answer: "We use four traces" },
  { doc: "paper-en", query: "withdrawn result", question: "Was any earlier result withdrawn, and why?", answer: "has been withdrawn" },
  { doc: "paper-en", query: "throughput cost per request", question: "What does the filter cost in throughput?", answer: "per request on the test machine" },
  { doc: "paper-en", query: "main results comparison", question: "How does Sieve-A compare with TinyLFU on the main results?", answer: "Table 1 summarises the main result" },
  { doc: "gpl-3.0", query: "patent grant from contributors", question: "What patent rights do contributors grant?", answer: "royalty-free patent license under the contributor" },
  { doc: "gpl-3.0", query: "warranty disclaimer", question: "Does the license give any warranty?", answer: "THERE IS NO WARRANTY FOR THE PROGRAM" },
  { doc: "gpl-3.0", query: "anti-circumvention laws DRM", question: "How does the license treat anti-circumvention laws?", answer: "Protecting Users' Legal Rights From Anti-Circumvention Law" },
  { doc: "gpl-3.0", query: "Affero network use", question: "How does GPLv3 interact with the Affero GPL?", answer: "Use with the GNU Affero General Public License" },
  { doc: "gpl-3.0", query: "installation information user products", question: "What must be provided as Installation Information for a User Product?", answer: "for a User Product means any methods" },
  { doc: "gpl-3.0", query: "terminating the license reinstated", question: "Can a terminated license be reinstated?", answer: "your license from a particular copyright holder is reinstated" },
  { doc: "mpl-2.0", query: "license termination breach", question: "What happens to my rights if I breach the MPL?", answer: "will terminate automatically if You fail to comply" },
  { doc: "mpl-2.0", query: "who publishes new license versions", question: "Who can publish new versions of the MPL?", answer: "Mozilla Foundation is the license steward" },
  { doc: "mpl-2.0", query: "liability limits damages", question: "What does the MPL say about liability for damages?", answer: "Limitation of Liability" },
  { doc: "mpl-2.0", query: "distributing source form obligations", question: "What must I do when distributing the Source Code Form?", answer: "Distribution of Source Form" },
  { doc: "vicksburg-ocr", query: "shell crater bury a horse", question: "What did the shells do when they landed?", answer: "big enough to bury a horse" },
  { doc: "vicksburg-ocr", query: "sewing buttons camp chores", question: "What chores could the soldiers do themselves?", answer: "sew on buttons" },
  { doc: "geobase-data-model", query: "document revisions history", question: "What is the revision history of this data model?", answer: "REVISION HISTORY" },
  { doc: "geobase-data-model", query: "abbreviation list", question: "What abbreviations does the document define?", answer: "ABBREVIATIONS" },
];
