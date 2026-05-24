import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const INPUT_PATH = path.join(ROOT, "analysis_work", "clinical_workbook_data.json");
const SCAN_PATH = path.join(ROOT, "analysis_work", "cancer_practitioner_post_hits.json");
const OUTPUT_PATH = path.join(ROOT, "clinical_patient_data.xlsx");
const CLEAN_DATA_PATH = path.join(ROOT, "analysis_work", "recalibrated_cancer_workbook_data.json");

const CANCER_DOCTOR_HEADERS = [
  "Name",
  "Role",
  "Treats Cancer Patients?",
  "Kruse Protocols Evidenced",
  "Cancer Treatment Details",
  "Source Evidence",
  "Source Files",
  "Kruse Cancer Relevance Score (1-10)",
  "Reasoning",
  "Review / Next Step",
];

const OTHER_HEADERS = [
  "Name",
  "Role",
  "Why Related",
  "Cancer / Protocol Details",
  "Source Evidence",
  "Source Files",
  "Kruse Cancer Relevance Score (1-10)",
  "Reasoning",
  "Review / Next Step",
];

const PEOPLE_HEADERS = [
  "Name / Handle",
  "Type",
  "Why May Help",
  "Cancer / Protocol Details",
  "Source Evidence",
  "Source Files",
  "Kruse Cancer Relevance Score (1-10)",
  "Reasoning",
  "Review / Next Step",
];

const PATIENT_HEADERS = [
  "Patient Handle",
  "Cancer Type",
  "Success Story (Yes/No/Partial)",
  "Protocols Used (e.g., DDW)",
  "Detailed Summary (2-3 sentences)",
  "Source Link",
];

const cancerDoctors = [
  {
    "Name": "Kruse Longevity Center / Dr. Jack Kruse",
    "Role": "Doctor / Kruse protocol source",
    "Treats Cancer Patients?": "Yes - forum consult/protocol guidance",
    "Kruse Protocols Evidenced": "AM sun/UV/IR; grounding; low nnEMF/low tech; DDW/Somlyai; seafood/DHA; CT when tolerated; circadian timing; tropical/caldera relocation for severe cases",
    "Cancer Treatment Details": "Directly advised pancreatic cancer, GBM/glioma, breast cancer, and cervical cancer cases. Guidance is environmental/mitochondrial: change the entire light-water-magnetism environment, use DDW intelligently, avoid blue/nnEMF, and time unavoidable conventional therapy circadianly.",
    "Source Evidence": "Pancreatic cancer: 'change everything' and read Gabor/Somlyai. Breast cancer: DDW/Somlyai plus sun/grounding/CT/low-tech stack. GBM: tropical/caldera sunlight context. Cervical cancer: redox-first stack, while drug protocol questions deferred to Makis.",
    "Source Files": "processed_mds/threads/my-dad-has-malignant-pancreatic-cancer-i´d-appreciate-suggestions-to-safe-his-life-if-not-too-late.27066.md; processed_mds/threads/dr-john-gordons-newest-cancer-pt.21299.md; processed_mds/threads/glioblastoma-diagnosis-for-my-brother-seeking-help-and-hope.29254.md; processed_mds/threads/catherines-optimal-journal.30462.md",
    "Kruse Cancer Relevance Score (1-10)": 10,
    "Reasoning": "10 because he is the source of the Kruse cancer framework and gives direct cancer-case guidance. Not an oncologist row; this is a Kruse-protocol authority row.",
    "Review / Next Step": "Use as protocol authority; for conventional oncology decisions use treating oncologist/surgeon.",
  },
  {
    "Name": "Dr. John Gordon",
    "Role": "Doctor / surgeon",
    "Treats Cancer Patients?": "Yes",
    "Kruse Protocols Evidenced": "Kruse-aligned mitochondrial surgeon; case used DDW/Somlyai, sun/UV, grounding, seafood/DHA, CT, low tech, no light after sunset, methylene blue, iodine",
    "Cancer Treatment Details": "Breast cancer patient Vervaina traveled to NOLA/Metairie to see him. Gordon assessed tumor/surgery timing, warned survival odds were poor without chemo, and advised finding an oncologist; Jack explicitly vouched for him.",
    "Source Evidence": "Patient: came to NOLA to see Dr John Gordon. Jack: 'I trust John huge' and called him a serious mitochondrial/Black Swan surgeon. Jack said his ideas would be powerful in Gordon's hands.",
    "Source Files": "processed_mds/threads/dr-john-gordons-newest-cancer-pt.21299.md; processed_mds/threads/advice-on-breast-health.22697.md",
    "Kruse Cancer Relevance Score (1-10)": 10,
    "Reasoning": "10 because this is a real named doctor directly involved in an active cancer case and specifically endorsed by Jack inside a Kruse-protocol context.",
    "Review / Next Step": "High-priority lead. Verify current practice/contact and cancer case scope.",
  },
  {
    "Name": "Block Center / Keith Block, MD",
    "Role": "Cancer clinic / doctor",
    "Treats Cancer Patients?": "Yes",
    "Kruse Protocols Evidenced": "Circadian / chrono-chemotherapy; possible grounding/outdoor strategy during infusion discussed by patient",
    "Cancer Treatment Details": "Jack pointed Vervaina toward Keith Block as the US cancer MD doing chrono-chemotherapy. Patient started intake with Block Center after that pointer.",
    "Source Evidence": "Jack: Keith Block has been doing chrono-chemotherapy for years and is the cancer MD in the US for that approach. Patient: called Block Center and began intake.",
    "Source Files": "processed_mds/threads/dr-john-gordons-newest-cancer-pt.21299.md",
    "Kruse Cancer Relevance Score (1-10)": 9,
    "Reasoning": "9 because it is a true cancer clinic with circadian chemotherapy evidence from Jack. Not 10 because source does not show full Kruse stack: DDW, nnEMF, sun/grounding, CT.",
    "Review / Next Step": "Strong clinic lead for patients who must do chemo and want circadian timing.",
  },
  {
    "Name": "Dr. William Makis",
    "Role": "Doctor / cancer protocol service",
    "Treats Cancer Patients?": "Yes",
    "Kruse Protocols Evidenced": "Used alongside Kruse stack: sun, DDW, grounding, seafood, methylene blue, PBM/sun, sweating, low tech; Makis protocol itself was ivermectin/mebendazole/supplements",
    "Cancer Treatment Details": "Catherine paid for a 3-month Makis service and followed his cervical cancer protocol with ivermectin and mebendazole. Jack deferred drug protocol questions to Makis.",
    "Source Evidence": "Catherine: paid Dr Makis for 3 months, received protocol, followed cervical cancer protocol with Iver and Mebendazole. Jack: 'Talk to Makis not me.'",
    "Source Files": "processed_mds/threads/catherines-optimal-journal.30462.md",
    "Kruse Cancer Relevance Score (1-10)": 8,
    "Reasoning": "8 because he is a real cancer-protocol doctor in a forum case, but the Kruse environmental protocol appears to come from Jack/Catherine, not necessarily Makis.",
    "Review / Next Step": "Good drug-protocol lead; verify exact cancer specialty and current service.",
  },
  {
    "Name": "Dr. Zsofia Clemens / Paleomedicina",
    "Role": "Doctor / clinic",
    "Treats Cancer Patients?": "Yes - especially GBM/brain tumor references",
    "Kruse Protocols Evidenced": "Strict Paleolithic Ketogenic Diet / PKD; metabolic cancer logic",
    "Cancer Treatment Details": "Forum members recommend Clemens/Paleomedicina for GBM/glioma and pancreatic cancer contexts. Protocol is strict PKD; not primarily DDW/light/EMF.",
    "Source Evidence": "GBM thread: Clemens deals with GBMs through strict PKD. Pancreatic cancer thread: member says somebody really good for cancer is Zsofia Clemens in Romania and links Paleomedicina.",
    "Source Files": "processed_mds/threads/glioblastoma-diagnosis-for-my-brother-seeking-help-and-hope.29254.md; processed_mds/threads/my-dad-has-malignant-pancreatic-cancer-i´d-appreciate-suggestions-to-safe-his-life-if-not-too-late.27066.md",
    "Kruse Cancer Relevance Score (1-10)": 8,
    "Reasoning": "8 because it is a real cancer-related clinic/doctor lead, but the evidence is PKD/metabolic, not full Kruse DDW-light-EMF protocol.",
    "Review / Next Step": "Strong for GBM/PKD research; verify current intake and cancer types treated.",
  },
  {
    "Name": "Gerson Clinic / Gerson Therapy",
    "Role": "Cancer clinic / therapy",
    "Treats Cancer Patients?": "Yes - cancer therapy lead, not Kruse-specific",
    "Kruse Protocols Evidenced": "Circadian sun missing-link discussion appears in forum, but not shown as part of clinic protocol",
    "Cancer Treatment Details": "Forum patient with brain surgery/tumor history went to Mexico for Gerson Therapy, stayed on protocol for two years, and later reconnected with Gerson clinic after seizure.",
    "Source Evidence": "Patient: went to Mexico for 3 weeks learning Gerson Therapy; later back in touch with Gerson clinic and described prior care as 'everything I'd hoped.'",
    "Source Files": "processed_mds/threads/charmanes-journal.23610.md; processed_mds/threads/gerson-therapy-detoxification-and-the-circadian-sun-missing-link.27569.md",
    "Kruse Cancer Relevance Score (1-10)": 5,
    "Reasoning": "5 because it is a real cancer clinic/therapy lead, but the corpus does not show DDW, nnEMF, sunrise, grounding, or Kruse cancer protocol use by the clinic.",
    "Review / Next Step": "Use as historical/alternative cancer clinic lead, not a Kruse-protocol lead.",
  },
  {
    "Name": "Puna Wai Ora Mind-Body Cancer Clinic",
    "Role": "Cancer clinic",
    "Treats Cancer Patients?": "Yes - implied by clinic name/source",
    "Kruse Protocols Evidenced": "Budwig oil/protein mixture; omega-3 emphasis. No DDW/light/EMF evidence in source.",
    "Cancer Treatment Details": "Mentioned as source for Budwig-style oil/protein mixture material.",
    "Source Evidence": "Post cites 'From: Puna Wai Ora Mind-Body Cancer Clinic' and alternative-cancer-care.com in a Budwig/oil-protein context.",
    "Source Files": "processed_mds/threads/oil-and-protein-mixture-recipe-an-experiment.23182.md",
    "Kruse Cancer Relevance Score (1-10)": 4,
    "Reasoning": "4 because it is a cancer clinic mention but not proven Kruse-aligned.",
    "Review / Next Step": "Low-priority unless specifically researching Budwig-style clinics.",
  },
  {
    "Name": "Dr. Nicholas Gonzalez",
    "Role": "Doctor / cancer protocol reference",
    "Treats Cancer Patients?": "Historical/reference",
    "Kruse Protocols Evidenced": "Gerson-like nutritional/enzyme therapy; EMF caveat mentioned by forum poster",
    "Cancer Treatment Details": "Mentioned as the more up-to-date version of Gerson; not a current clinic lead in the extracted forum data.",
    "Source Evidence": "Forum post: Nicholas Gonzalez MD is the most up-to-date version of Gerson; harder now with EMFs.",
    "Source Files": "processed_mds/threads/i-finally-feel-like-a-success-story.8975.md",
    "Kruse Cancer Relevance Score (1-10)": 4,
    "Reasoning": "4 because it is cancer-protocol relevant but historical/reference-only and not demonstrated as current Kruse care.",
    "Review / Next Step": "Reference lead, not primary outreach lead.",
  },
];

const otherPractitioners = [
  {
    "Name": "Gabor Somlyai / HYD DDW framework",
    "Role": "DDW cancer researcher / protocol source",
    "Why Related": "Core DDW cancer framework repeatedly recommended in Kruse cancer threads.",
    "Cancer / Protocol Details": "Books and DDW approach cited for cancer, including pancreatic cancer and long-term DDW use. Practical forum discussions include ppm titration and duration.",
    "Source Evidence": "Jack told breast cancer patient to get Somlyai's book. Pancreatic cancer thread says Gabor's book has a lot on that tumor type.",
    "Source Files": "processed_mds/threads/dr-john-gordons-newest-cancer-pt.21299.md; processed_mds/threads/my-dad-has-malignant-pancreatic-cancer-i´d-appreciate-suggestions-to-safe-his-life-if-not-too-late.27066.md; processed_mds/threads/book-list.18711.md",
    "Kruse Cancer Relevance Score (1-10)": 8,
    "Reasoning": "8: central DDW cancer source, but not a treating doctor/clinic row.",
    "Review / Next Step": "Use for DDW protocol logic; verify any current clinical service separately.",
  },
  {
    "Name": "Dr. Laszlo Boros",
    "Role": "MD / biochemist / DDW researcher",
    "Why Related": "DDW/deuterium expert; forum specifically mentions renal cancer/DDW work.",
    "Cancer / Protocol Details": "Forum says Boros has done notable work on renal cancers with DDW and discusses DDW slowing prostate/brain cancer. Another source says he is a biochemist, not a clinician.",
    "Source Evidence": "Cancer journey thread: amazing work on renal cancers with DDW; DDW thread: Boros is a biochemist and not a clinician.",
    "Source Files": "processed_mds/threads/cancer-journey.21492.md; processed_mds/threads/50-ppm-ddw.23932.md; processed_mds/threads/deuterium-in-foods.20423.md",
    "Kruse Cancer Relevance Score (1-10)": 7,
    "Reasoning": "7: highly relevant DDW cancer science, but not a treating clinician in the forum evidence.",
    "Review / Next Step": "Use as DDW science lead, not first-line patient-care lead.",
  },
  {
    "Name": "Dr. Thomas Seyfried",
    "Role": "Cancer metabolism researcher",
    "Why Related": "Metabolic cancer / ketogenic cancer framework overlaps with Kruse mitochondrial cancer view.",
    "Cancer / Protocol Details": "Cited for cancer as a metabolic disease, ketogenic/fasting/metabolic therapies, and Warburg/mitochondrial dysfunction.",
    "Source Evidence": "Forum quotes reviews recommending Seyfried's Cancer as a Metabolic Disease to cancer patients and specialists.",
    "Source Files": "processed_mds/threads/awesome-report-on-ketogenic-diet-cancer.5188.md; processed_mds/threads/deterium-depleted-water.30664.md; processed_mds/threads/cancer-proof.32500.md",
    "Kruse Cancer Relevance Score (1-10)": 6,
    "Reasoning": "6: cancer expertise is strong, but not a Kruse clinician/clinic and Jack critiques missing deuterium/biophysics.",
    "Review / Next Step": "Useful theory lead, not a Kruse cancer practitioner lead.",
  },
  {
    "Name": "Dr. Jerry Tennant",
    "Role": "MD / voltage medicine",
    "Why Related": "Cancer electrical/voltage framing is adjacent to Kruse redox/electricity ideas.",
    "Cancer / Protocol Details": "Referenced for 'Healing is Voltage - Cancer's On/Off Switches: Polarity' and still practicing; source ties cancer to hypoxia/cellular voltage.",
    "Source Evidence": "Forum recommends Tennant to a liposarcoma patient and links Cancer's On/Off Switches material.",
    "Source Files": "processed_mds/threads/aging-is-not-a-disease-damn-it.25242.md; processed_mds/threads/low-cortisol-levels.14194.md",
    "Kruse Cancer Relevance Score (1-10)": 5,
    "Reasoning": "5: real doctor and cancer-voltage relevance, but no evidence he treats cancer with Kruse DDW/sun/EMF protocols.",
    "Review / Next Step": "Secondary lead; verify current cancer-patient work.",
  },
  {
    "Name": "Dr. David Brownstein",
    "Role": "Doctor / iodine",
    "Why Related": "Iodine cancer anecdotes overlap with forum cancer protocols that mention Lugol's/iodine.",
    "Cancer / Protocol Details": "Referenced for iodine protocol and cancer anecdotes including uterine/vaginal and breast cancer context.",
    "Source Evidence": "Forum references Brownstein's iodine protocol and cancer cases.",
    "Source Files": "processed_mds/threads/antibody-wakes-up-t-cells-to-make-cancer-vanish.7241.md",
    "Kruse Cancer Relevance Score (1-10)": 4,
    "Reasoning": "4: cancer-adjacent doctor; no source evidence of Kruse cancer protocol use.",
    "Review / Next Step": "Consider only for iodine-specific review.",
  },
  {
    "Name": "Dr. Jorge Flechas",
    "Role": "Doctor / iodine",
    "Why Related": "Iodine deficiency/cancer material is repeatedly cited.",
    "Cancer / Protocol Details": "Forum lists iodine deficiency and cancer resources and iodine sufficiency material.",
    "Source Evidence": "Jorge Flechas iodine deficiency & cancer and total body iodine sufficiency references.",
    "Source Files": "processed_mds/threads/beautiful-man-and-nature-in-tune-and-producing-unrefined-sea-salt.20949.md; processed_mds/threads/iodine-epi-paleo-rx-thyroid-and-carb-linkage.9535.md",
    "Kruse Cancer Relevance Score (1-10)": 4,
    "Reasoning": "4: relevant to iodine, not proven Kruse cancer treatment.",
    "Review / Next Step": "Low-priority unless iodine is central to case.",
  },
  {
    "Name": "Dr. Dietrich Klinghardt",
    "Role": "Doctor / EMF-infectious disease practitioner",
    "Why Related": "RF/MW/EMF mitigation overlaps with Kruse nnEMF cancer environment logic.",
    "Cancer / Protocol Details": "Cited for RF/MW radiation warnings and biological protection; not presented as a cancer specialist in source.",
    "Source Evidence": "Forum: Klinghardt's specialty is Lyme/autism/infectious disease, and he has warned on RF/MW radiation for years.",
    "Source Files": "processed_mds/threads/1-281-days-a-journal-of-recovery-from-severe-me-cfs.23239.md; processed_mds/threads/2-4-gz-wi-fi-increases-antibiotic-resistance-and-biofilm-formation.24510.md",
    "Kruse Cancer Relevance Score (1-10)": 4,
    "Reasoning": "4: EMF-relevant practitioner, not cancer/DDW specialist in the forum evidence.",
    "Review / Next Step": "Useful for EMF/complex illness, not primary cancer lead.",
  },
  {
    "Name": "Dr. Paul Marik",
    "Role": "Doctor / protocol medicine",
    "Why Related": "Mentioned as a doctor with broad medical knowledge and ivermectin-related protocol context.",
    "Cancer / Protocol Details": "Forum evidence found him in treatment/protocol context, not as a Kruse cancer practitioner.",
    "Source Evidence": "Post says to find doctors like Dr. Marik and lists his medical fields; other forum material references IVM.",
    "Source Files": "processed_mds/threads/treatment-of-the-jabbed-considerations.29616.md",
    "Kruse Cancer Relevance Score (1-10)": 4,
    "Reasoning": "4: medically relevant, but no direct forum evidence of cancer patients treated with Kruse protocols.",
    "Review / Next Step": "Keep as adjacent protocol lead only.",
  },
];

const specificPeople = [
  {
    "Name / Handle": "AcuHealth",
    "Type": "Forum practitioner lead / acupuncturist",
    "Why May Help": "Not a doctor row, but clinically relevant. Owns/operates an acupuncture clinic, joined Optimal Klub practitioners forum, sees patients, and reports DDW use with stage 4 cancer patients / cancer clinic next door.",
    "Cancer / Protocol Details": "Referred stage 4 cancer patients; began first patient on DDW 10ppm; works with cancer clinic next door that started three patients on 10ppm DDW and all three lowered cancer markers; Arizona/Phoenix/Hydro Health mentioned.",
    "Source Evidence": "AcuHealth: 'I am referred patients with stage 4 cancer...' and 'Work with Cancer clinic next door started last 3 patients 10ppm. All 3 lowered Cancer markers.'",
    "Source Files": "processed_mds/threads/catherines-optimal-journal.30462.md; processed_mds/threads/deuterium-depletion.29377.md; processed_mds/threads/feeling-totally-conflicted-about-my-career.30900.md; processed_mds/threads/roberts-optimal-journal.30366.md",
    "Kruse Cancer Relevance Score (1-10)": 8,
    "Reasoning": "8 as a lead, not a doctor. Strong DDW/cancer patient evidence, but credentials/legal name/clinic identity are unknown.",
    "Review / Next Step": "Verify legal name, license, clinic, and whether cancer care is direct or through neighboring clinic.",
  },
  {
    "Name / Handle": "JanSz",
    "Type": "Forum DDW/Somlyai/Boros knowledge lead",
    "Why May Help": "Not a practitioner row. Useful because he repeatedly discusses DDW dosing, Somlyai/Boros material, and cancer-related DDW practicalities.",
    "Cancer / Protocol Details": "Discusses DDW-25/Qlarivia, Somlyai duration, ppm mixing, breath/saliva/urine deuterium testing, and DDW in cancer contexts.",
    "Source Evidence": "Multiple DDW threads; pancreatic cancer thread and Gordon cancer thread include practical DDW comments.",
    "Source Files": "processed_mds/threads/my-dad-has-malignant-pancreatic-cancer-i´d-appreciate-suggestions-to-safe-his-life-if-not-too-late.27066.md; processed_mds/threads/dr-john-gordons-newest-cancer-pt.21299.md; processed_mds/threads/50-ppm-ddw.23932.md",
    "Kruse Cancer Relevance Score (1-10)": 6,
    "Reasoning": "6 as a knowledge lead only; not a doctor/clinic.",
    "Review / Next Step": "Use for forum navigation/DDW references, not medical guidance.",
  },
  {
    "Name / Handle": "Mat.I",
    "Type": "Forum research lead",
    "Why May Help": "Not a practitioner row. Useful for finding GBM/PKD/Clemens/Somlyai references.",
    "Cancer / Protocol Details": "In GBM thread, points to Gabor Somlyai and Dr. Zsofia Clemens/Paleomedicina; notes PKD and missing light story.",
    "Source Evidence": "GBM thread: recommends Somlyai book and Clemens/Paleomedicina for GBM via strict PKD.",
    "Source Files": "processed_mds/threads/glioblastoma-diagnosis-for-my-brother-seeking-help-and-hope.29254.md",
    "Kruse Cancer Relevance Score (1-10)": 5,
    "Reasoning": "5 as a useful navigator, not a practitioner.",
    "Review / Next Step": "Use to trace source links, not as clinical contact.",
  },
];

function normalizeSpaces(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function xmlSafe(value) {
  let output = "";
  for (const char of String(value ?? "")) {
    const code = char.codePointAt(0);
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff)
    ) output += char;
  }
  return output;
}

function cleanField(value, max = 32000) {
  const cleaned = normalizeSpaces(xmlSafe(value)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (!cleaned) return "Unknown";
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 90).trim()} [shortened for Excel cell limit; full evidence in recalibrated JSON]`;
}

function splitList(value) {
  return normalizeSpaces(value).split(/\s*;\s*/).map((item) => item.trim()).filter(Boolean);
}

function sourceFileOnly(source) {
  return normalizeSpaces(source).replace(/\s+\(https?:\/\/.*?\)\s*$/i, "");
}

function cleanPatientHandle(value) {
  const handle = normalizeSpaces(xmlSafe(value)).replace(/([a-z])Dr\..*$/g, "$1").replace(/\s+said:?$/i, "").trim();
  if (!handle || /^\[email redacted\]$/i.test(handle)) return "Redacted email-like forum handle(s)";
  return handle;
}

function successRank(value) {
  return { No: 1, Partial: 2, Yes: 3 }[value] || 1;
}

function mergePatients(rows) {
  const merged = new Map();
  for (const raw of rows) {
    const handle = cleanPatientHandle(raw["Patient Handle"]);
    const key = handle.toLowerCase();
    const existing = merged.get(key) || {
      handle,
      cancerTypes: new Set(),
      success: "No",
      protocols: new Set(),
      summaries: [],
      sources: new Set(),
      mentionCount: 0,
      redacted: /redacted email-like/i.test(handle),
    };
    existing.mentionCount += 1;
    const cancerType = normalizeSpaces(raw["Cancer Type"]) || "Unknown";
    if (cancerType && !/^Unknown$/i.test(cancerType)) existing.cancerTypes.add(cancerType);
    if (successRank(raw["Success Story (Yes/No/Partial)"]) > successRank(existing.success)) existing.success = raw["Success Story (Yes/No/Partial)"];
    for (const protocol of splitList(raw["Protocols Used (e.g., DDW)"])) if (!/^Unknown$/i.test(protocol)) existing.protocols.add(protocol);
    for (const source of splitList(raw["Source Link"]).map(sourceFileOnly).filter(Boolean)) existing.sources.add(source);
    const summary = cleanField(raw["Detailed Summary (2-3 sentences)"], 1000);
    if (summary !== "Unknown" && existing.summaries.length < 3 && !existing.summaries.includes(summary)) existing.summaries.push(summary);
    merged.set(key, existing);
  }
  return [...merged.values()].map((row) => {
    const cancerTypes = row.cancerTypes.size ? [...row.cancerTypes].sort().join("; ") : "Unknown";
    const protocols = row.protocols.size ? [...row.protocols].sort().join("; ") : "Unknown";
    const outcome = row.success === "Yes" ? "Success/remission wording found." : row.success === "Partial" ? "Partial/stable/improving wording found." : "No clear success outcome extracted.";
    const redacted = row.redacted ? " Source handle was already [email redacted]; original user cannot be recovered from markdown." : "";
    return {
      "Patient Handle": row.handle,
      "Cancer Type": cancerTypes,
      "Success Story (Yes/No/Partial)": row.success,
      "Protocols Used (e.g., DDW)": cleanField(protocols, 3500),
      "Detailed Summary (2-3 sentences)": cleanField(`${row.handle}: ${row.mentionCount} cancer-related extracted mention(s). Cancer type(s): ${cancerTypes}. Protocols: ${protocols}. ${outcome}${redacted}`, 1800),
      "Source Link": cleanField([...row.sources].sort().join("; "), 32000),
    };
  }).sort((a, b) => a["Patient Handle"].localeCompare(b["Patient Handle"]));
}

function cleanRows(rows, headers) {
  return rows.map((row) => {
    const out = {};
    for (const header of headers) out[header] = typeof row[header] === "number" ? row[header] : cleanField(row[header], 32000);
    return out;
  });
}

function columnLetter(index) {
  let n = index + 1;
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function writeSheet(sheet, headers, rows, tableName, widths) {
  const values = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ""))];
  const lastCol = columnLetter(headers.length - 1);
  const lastRow = values.length;
  sheet.getRange(`A1:${lastCol}${lastRow}`).values = values;
  sheet.getRange(`A1:${lastCol}1`).format = { fill: "#1F4E78", font: { bold: true, color: "#FFFFFF" } };
  sheet.getRange(`A1:${lastCol}1`).format.wrapText = true;
  sheet.getRange(`A1:${lastCol}1`).format.rowHeight = 54;
  sheet.getRange(`A1:${lastCol}${lastRow}`).format.wrapText = false;
  widths.forEach((width, index) => {
    sheet.getRange(`${columnLetter(index)}:${columnLetter(index)}`).format.columnWidth = width;
  });
  sheet.tables.add(`A1:${lastCol}${lastRow}`, true, tableName);
}

async function main() {
  const input = JSON.parse(await fs.readFile(INPUT_PATH, "utf8"));
  const scan = JSON.parse(await fs.readFile(SCAN_PATH, "utf8"));
  const patients = mergePatients(input.cancerPatients);
  const doctors = cleanRows(cancerDoctors, CANCER_DOCTOR_HEADERS);
  const others = cleanRows(otherPractitioners, OTHER_HEADERS);
  const people = cleanRows(specificPeople, PEOPLE_HEADERS);

  await fs.writeFile(CLEAN_DATA_PATH, JSON.stringify({
    generated_at: new Date().toISOString(),
    post_scan: {
      posts_scanned: scan.posts_scanned,
      hits: scan.hits,
      raw_candidates: scan.candidates.length,
    },
    rules: {
      cancer_doctors: "Only named doctors/clinics with cancer patient treatment evidence or cancer clinic status. 10 requires professional doctor/clinic plus Kruse-protocol cancer evidence.",
      other_practitioners: "Professional/research/clinic-adjacent leads that are related but not proven cancer+Kruse treatment providers.",
      specific_people: "Forum handles or people who may help, separated from professional doctor/clinic sheet.",
    },
    cancerDoctors: doctors,
    otherPractitioners: others,
    specificPeople: people,
    cancerPatients: patients,
  }, null, 2));

  const workbook = Workbook.create();
  writeSheet(workbook.worksheets.add("Cancer Doctors Clinics"), CANCER_DOCTOR_HEADERS, doctors, "CancerDoctorsTable", [28, 24, 20, 58, 78, 78, 70, 16, 58, 48]);
  writeSheet(workbook.worksheets.add("Other Practitioners"), OTHER_HEADERS, others, "OtherPractitionersTable", [28, 26, 52, 72, 78, 70, 16, 58, 48]);
  writeSheet(workbook.worksheets.add("Specific People"), PEOPLE_HEADERS, people, "SpecificPeopleTable", [26, 26, 58, 72, 78, 70, 16, 52, 48]);
  writeSheet(workbook.worksheets.add("Cancer Patients"), PATIENT_HEADERS, patients, "CancerPatientsTable", [28, 30, 24, 54, 100, 90]);

  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(OUTPUT_PATH);

  console.log(JSON.stringify({
    output: OUTPUT_PATH,
    clean_data: CLEAN_DATA_PATH,
    posts_scanned: scan.posts_scanned,
    raw_hits: scan.hits,
    raw_candidates: scan.candidates.length,
    cancer_doctors: doctors.length,
    other_practitioners: others.length,
    specific_people: people.length,
    cancer_patients: patients.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
