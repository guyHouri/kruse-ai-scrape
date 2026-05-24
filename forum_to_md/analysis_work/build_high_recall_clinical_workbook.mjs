import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const THREAD_DIR = path.join(ROOT, "processed_mds", "threads");
const INPUT_PATH = path.join(ROOT, "analysis_work", "clinical_workbook_data.json");
const OUTPUT_PATH = path.join(ROOT, "clinical_patient_data.xlsx");
const CLEAN_DATA_PATH = path.join(ROOT, "analysis_work", "high_recall_clinical_workbook_data.json");
const PREVIEW_DIR = path.join(ROOT, "analysis_work", "previews");

const PRACTITIONER_HEADERS = [
  "Name",
  "Role (Doctor/Coach/Lab/Other)",
  "Triage Tier",
  "Cancer/Kruse Protocol Summary",
  "Alignment Evidence",
  "Cancer Expertise (Yes/No)",
  "Contact Details (emails/links)",
  "Source Link (specific file)",
  "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)",
  "Reasoning / Why This Score",
  "Review Notes",
];

const PATIENT_HEADERS = [
  "Patient Handle",
  "Cancer Type",
  "Success Story (Yes/No/Partial)",
  "Protocols Used (e.g., DDW)",
  "Detailed Summary (2-3 sentences)",
  "Source Link",
];

const PROTOCOL_PATTERNS = [
  ["DDW / deuterium depletion", /\b(?:DDW|deuterium|deuterium depleted|deuterium depletion|Preventa|Qlarivia|Litewater|Hydro[- ]?Health|10ppm|25ppm|50ppm)\b/i],
  ["Sun / sunrise / UV / IR", /\b(?:sunrise|sunlight|sun\b|UV\b|UVA|UVB|infrared|IR-A|solar|heliotherapy|red light|photobiomodulation|PBM)\b/i],
  ["Grounding / earthing", /\b(?:grounding|earthing)\b/i],
  ["nnEMF / blue-light reduction", /\b(?:nnEMF|EMF|RF|microwave|Wi-?Fi|blue light|blue blockers?|low tech|no light after sunset)\b/i],
  ["Cold thermogenesis / CT", /\b(?:cold thermogenesis|\bCT\b|ice bath|cold tub|cold water|cold plunge)\b/i],
  ["Epi-paleo / seafood / DHA", /\b(?:epi-?paleo|seafood|oysters?|DHA)\b/i],
  ["Ketogenic / PKD", /\b(?:keto|ketogenic|ketosis|paleolithic ketogenic|PKD)\b/i],
  ["Circadian / chrono-therapy", /\b(?:circadian|chrono-?chemo|chrono-?therapy|melatonin|darkness|dark room)\b/i],
  ["Methylene blue", /\bmethylene blue\b/i],
  ["Ivermectin / mebendazole / fenbendazole", /\b(?:ivermectin|iver\b|mebendazole|fenbendazole|febendazole|feben)\b/i],
  ["Iodine", /\b(?:iodine|lugol)\b/i],
  ["Conventional oncology", /\b(?:chemo(?:therapy)?|radiation|radiotherapy|surgery|mastectomy|lumpectomy|immunotherapy|oncologist)\b/i],
];

const CANCER_RE =
  /\b(?:cancers?|oncolog(?:y|ist|ical)?|tumou?rs?|malignan(?:t|cy)?|metasta(?:sis|tic|sized)?|carcinoma|sarcoma|lymphoma|leuk(?:a)?emia|myeloma|melanoma|glioblastoma|glioma|chemo(?:therapy)?|radiation|radiotherapy|remission|neoplasm|precancer(?:ous)?|mastectomy|lumpectomy|BRCA|NED|biopsy|immunotherapy|stage\s+(?:I{1,3}|IV|[1-4])\b|cancer markers?)\b/i;

const DIRECT_CANCER_CARE_RE =
  /\b(?:cancer clinic|cancer center|cancer centre|oncolog(?:ist|y)|stage\s*4\s+cancer patients?|cancer patients?|patients?\s+with\s+[^.]{0,80}cancer|treat(?:s|ed|ing)?\s+[^.]{0,80}cancer|work(?:ing)?\s+with\s+[^.]{0,80}cancer|referred patients?\s+with\s+[^.]{0,80}cancer|lowered\s+cancer markers?|chrono-?chemo|mastectomy|lumpectomy|tumou?r board)\b/i;

const SELF_PRACTICE_RE =
  /\b(?:my clinic|our clinic|my practice|our practice|own and operate\s+[^.]{0,80}clinic|I own\s+[^.]{0,80}clinic|I run\s+[^.]{0,80}clinic|work with\s+[^.]{0,80}clinic|my patients|our patients|my clients|our clients|working with\s+[^.]{0,80}patients|I treat|I see patients|referred patients|practitioners forum|skilled acupuncturist|functional medicine practice|building biologist)\b/i;

const RESEARCH_ONLY_RE =
  /\b(?:study|studies|paper|article|book|podcast|research|review|abstract|lecture|interview|author|professor)\b/i;

const BAD_NAME_RE =
  /^(?:Adjuvant Endocrine Therapy|Alternative Health|Cancer Therapy|Cold Therapy|Gut Health|National Center|Manual Therapy|Mental Health|Medical Center|Medical Doctor|British Medical|American Veterinary Medical|Center|Clinic|Doctor|Dr\.?|Hospital|Source|The Doctor|This Doctor)$/i;

const ALIASES = new Map([
  ["jack", "Kruse Longevity Center / Dr. Jack Kruse"],
  ["jack kruse", "Kruse Longevity Center / Dr. Jack Kruse"],
  ["dr jack", "Kruse Longevity Center / Dr. Jack Kruse"],
  ["dr jack kruse", "Kruse Longevity Center / Dr. Jack Kruse"],
  ["dr kruse", "Kruse Longevity Center / Dr. Jack Kruse"],
  ["kruse longevity center", "Kruse Longevity Center / Dr. Jack Kruse"],
  ["john gordon", "Dr. John Gordon"],
  ["dr john gordon", "Dr. John Gordon"],
  ["dr gordon", "Dr. John Gordon"],
  ["block center", "Block Center / Keith Block, MD"],
  ["keith block", "Block Center / Keith Block, MD"],
  ["dr keith block", "Block Center / Keith Block, MD"],
  ["makis", "Dr. Makis"],
  ["dr makis", "Dr. Makis"],
  ["zsofia clemens", "Dr. Zsofia Clemens / Paleomedicina"],
  ["dr zsofia clemens", "Dr. Zsofia Clemens / Paleomedicina"],
  ["paleomedicina", "Dr. Zsofia Clemens / Paleomedicina"],
  ["gabor somlyai", "Gabor Somlyai / DDW cancer framework"],
  ["dr somlyai", "Gabor Somlyai / DDW cancer framework"],
  ["somlyai", "Gabor Somlyai / DDW cancer framework"],
  ["laszlo boros", "Dr. Laszlo Boros"],
  ["lazlo boros", "Dr. Laszlo Boros"],
  ["dr boros", "Dr. Laszlo Boros"],
  ["dr laszlo boros", "Dr. Laszlo Boros"],
  ["dr lazlo boros", "Dr. Laszlo Boros"],
  ["thomas seyfried", "Dr. Thomas Seyfried"],
  ["dr seyfried", "Dr. Thomas Seyfried"],
  ["gerson clinic", "Gerson Clinic / Gerson Therapy"],
  ["gerson therapy", "Gerson Clinic / Gerson Therapy"],
  ["acuhealth", "AcuHealth"],
]);

const MANUAL_LEADS = [
  {
    name: "Dr. John Gordon",
    role: "Doctor",
    score: 10,
    cancerExpertise: "Yes",
    source: "processed_mds/threads/dr-john-gordons-newest-cancer-pt.21299.md (posts 240832, 240837, 240863)",
    contact: "Unknown; Metairie/New Orleans area mentioned in source thread",
    evidence:
      "Breast cancer patient traveled to NOLA/Metairie to see Gordon; Jack wrote that he trusts John and described him as a serious mitochondrial/Black Swan surgeon.",
    summary:
      "Direct breast-cancer case inside the forum. Gordon evaluated surgery/chemo sequencing while Jack and patient discussed DDW/Somlyai, seafood/DHA, grounding, AM light/UV, CT, low tech/no light after sunset, topical iodine, methylene blue, and environmental redox work.",
    reason:
      "10/10 because this is a named clinician directly involved with an active cancer patient, explicitly vouched for by Jack, with the case managed alongside Kruse-specific DDW/light/grounding/CT/EMF protocols.",
  },
  {
    name: "Kruse Longevity Center / Dr. Jack Kruse",
    role: "Doctor",
    score: 10,
    cancerExpertise: "Yes",
    source:
      "processed_mds/threads/my-dad-has-malignant-pancreatic-cancer-i´d-appreciate-suggestions-to-safe-his-life-if-not-too-late.27066.md; processed_mds/threads/glioblastoma-diagnosis-for-my-brother-seeking-help-and-hope.29254.md; processed_mds/threads/catherines-optimal-journal.30462.md",
    contact: "Forum source links only in extracted data",
    evidence:
      "Jack directly commented on pancreatic cancer, GBM/glioma, breast cancer, and cervical cancer threads with environmental and DDW protocol logic.",
    summary:
      "Primary source of the Kruse cancer framework in the corpus: AM sun/UV/IR, grounding, low nnEMF/low-tech living, seafood/DHA, sleep/no light after sunset, CT when tolerated, tropical/caldera relocation for severe cases, DDW/Somlyai-style deuterium depletion, and circadian handling of conventional therapy.",
    reason:
      "10/10 for Kruse-protocol relevance because he is the source of the environmental cancer protocol logic and comments directly on multiple cancer cases; not scored here as a conventional oncologist.",
  },
  {
    name: "AcuHealth",
    role: "Other",
    score: 8,
    cancerExpertise: "Yes",
    source:
      "processed_mds/threads/catherines-optimal-journal.30462.md (post 349612); processed_mds/threads/deuterium-depletion.29377.md (post 353785); processed_mds/threads/feeling-totally-conflicted-about-my-career.30900.md (post 353655); processed_mds/threads/roberts-optimal-journal.30366.md (post 347446)",
    contact: "Forum handle only; Arizona/Phoenix area and acupuncture clinic mentioned",
    evidence:
      "AcuHealth wrote: referred patients with stage 4 cancer, began first patient on 10ppm DDW, works with a cancer clinic next door that started three patients on 10ppm DDW and all three lowered cancer markers; also owns/operates an acupuncture clinic and joined the Optimal Klub practitioners forum.",
    summary:
      "High-value forum practitioner lead. Evidence indicates an acupuncture-clinic operator in Arizona using/observing DDW with stage 4 cancer patients and a neighboring cancer clinic, but formal credentials and clinic identity need confirmation.",
    reason:
      "8/10 because the source shows direct stage 4 cancer patient exposure plus DDW use and cancer-marker outcomes, but the row is a forum handle with incomplete credentials, so it is marked Review Needed rather than 10/10.",
    review: "Review Needed: forum handle; verify legal name, license, clinic name, and whether cancer work is direct or through neighboring clinic.",
  },
  {
    name: "Block Center / Keith Block, MD",
    role: "Doctor",
    score: 9,
    cancerExpertise: "Yes",
    source: "processed_mds/threads/dr-john-gordons-newest-cancer-pt.21299.md (posts 240864, 240982)",
    contact: "Unknown in extracted source; Block Center named",
    evidence:
      "Jack identified Keith Block as the cancer MD doing chrono-chemotherapy and Vervaina began Block Center intake after Jack's pointer.",
    summary:
      "Cancer clinic/MD lead for circadian chemotherapy. Relevant when conventional chemotherapy is unavoidable and timing/circadian logic can be layered onto Kruse light/grounding/EMF mitigation.",
    reason:
      "9/10 because it is a named cancer clinic/MD with a circadian chemotherapy angle explicitly recommended by Jack; the source does not prove the clinic itself uses the full Kruse stack.",
  },
  {
    name: "Dr. Makis",
    role: "Doctor",
    score: 8,
    cancerExpertise: "Yes",
    source: "processed_mds/threads/catherines-optimal-journal.30462.md",
    contact: "Unknown in extracted source; paid service mentioned",
    evidence:
      "Catherine paid for a three-month service and later followed Makis's cervical cancer protocol with ivermectin and mebendazole; Jack deferred drug-protocol questions to Makis.",
    summary:
      "Cancer drug-protocol lead used alongside Catherine's Kruse environmental protocol. Evidence centers on ivermectin/mebendazole and supplements rather than Makis himself applying the full Kruse environmental protocol.",
    reason:
      "8/10 because paid cancer-protocol involvement is shown, but Kruse alignment appears layered by Jack/Catherine rather than proven as Makis's own method.",
  },
  {
    name: "Dr. Zsofia Clemens / Paleomedicina",
    role: "Doctor",
    score: 8,
    cancerExpertise: "Yes",
    source:
      "processed_mds/threads/glioblastoma-diagnosis-for-my-brother-seeking-help-and-hope.29254.md; processed_mds/threads/my-dad-has-malignant-pancreatic-cancer-i´d-appreciate-suggestions-to-safe-his-life-if-not-too-late.27066.md",
    contact: "https://www.paleomedicina.com/en/dr-zsofia-clemens",
    evidence: "Forum members recommend Clemens/Paleomedicina for GBM and pancreatic-cancer contexts via strict PKD.",
    summary:
      "Clinician/clinic cancer lead for strict Paleolithic Ketogenic Diet, especially GBM/glioma. Strong diet/metabolic-cancer relevance, but the extracted evidence says the light/EMF/DDW story is not the center of that approach.",
    reason:
      "8/10 because it is a repeatedly recommended cancer clinician/clinic lead, but PKD-centered rather than fully Kruse-protocol-centered.",
  },
];

function normalizeSpaces(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function stripMarkdown(value) {
  return normalizeSpaces(
    String(value ?? "")
      .replace(/!\[[^\]]*]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/[*_`>#]+/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
  );
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
  return `${cleaned.slice(0, max - 125).trim()} [field shortened to fit Excel cell limit; source details remain in high_recall_clinical_workbook_data.json]`;
}

function splitList(value) {
  return normalizeSpaces(value)
    .split(/\s*;\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function canonicalDisplayName(rawName) {
  let name = cleanField(stripMarkdown(rawName), 180)
    .replace(/\s+\((?:https?:\/\/.*?)\)$/i, "")
    .replace(/\bDr\s+/i, "Dr. ")
    .replace(/[,:;()[\]{}]+$/g, "")
    .trim();
  const key = aliasKey(name);
  return ALIASES.get(key) || name;
}

function aliasKey(value) {
  return normalizeSpaces(value)
    .toLowerCase()
    .replace(/\bdr\.?\s+/g, "dr ")
    .replace(/\bdoctor\s+/g, "dr ")
    .replace(/\b(?:m\.?d\.?|d\.?o\.?|n\.?d\.?|d\.?c\.?|ph\.?d\.?)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalKey(value) {
  return aliasKey(canonicalDisplayName(value)).replace(/\bdr\s+/g, "");
}

function roleRank(role) {
  return { Doctor: 4, Lab: 3, Coach: 2, Other: 1 }[role] || 0;
}

function isBadName(name) {
  if (!name || name === "Unknown") return true;
  if (name.length < 3 || name.length > 100) return true;
  if (BAD_NAME_RE.test(name)) return true;
  if (/\b(?:what|where|when|why|which|that|this|these|those|their|there|would|could|should|because|before|after|during|around|through|under|with|your)\b/i.test(name) && !/\b(?:Clinic|Center|Centre|Institute|Hospital|Labs?|Laboratory|Diagnostics|Medical|Health|Dr\.|MD|PhD|Therapy|Therapeutics)\b/.test(name)) return true;
  if (/^Dr\.?\s+(?:Los Angeles|Pollack Water|Kruse NOT|Que|Water|Light|Sun|Cold)$/i.test(name)) return true;
  return false;
}

function inferRole(name, evidence, defaultRole = "Other") {
  const nameText = String(name || "").toLowerCase();
  const evidenceText = String(evidence || "").toLowerCase();
  const haystack = `${nameText} ${evidenceText}`;
  if (/\b(?:lab|laborator|diagnostics|pathology|heartlab|spectracell|genova|quest|labcorp|cyrex|vibrant|zrt|dutch|23andme|promethease)\b/.test(haystack)) return "Lab";
  if (/\b(?:coach|coaching)\b/.test(nameText) || /\b(?:i am|i'm|as a)\s+(?:a\s+)?(?:coach|health coach|nutrition coach)\b/.test(evidenceText)) return "Coach";
  if (/^(?:dr\.?|doctor)\b/i.test(name) || /\b(?:md|m\.d\.|do|d\.o\.|nd|n\.d\.|dc|d\.c\.)\b/i.test(name)) return "Doctor";
  if (/\b(?:i am|i'm|as a|licensed|board[- ]certified)\s+(?:a\s+)?(?:doctor|physician|surgeon|oncologist|dentist|chiropractor|naturopath|naturopathic doctor)\b/.test(evidenceText)) return "Doctor";
  return ["Doctor", "Coach", "Lab", "Other"].includes(defaultRole) ? defaultRole : "Other";
}

function protocolsIn(text) {
  const found = [];
  for (const [label, re] of PROTOCOL_PATTERNS) if (re.test(text)) found.push(label);
  return [...new Set(found)];
}

function hasKruseProtocol(text) {
  return protocolsIn(text).some((item) => item !== "Conventional oncology");
}

function contactSet(text) {
  const contacts = new Set();
  for (const match of String(text).matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) contacts.add(match[0]);
  for (const match of String(text).matchAll(/https?:\/\/[^\s>)\]]+/gi)) contacts.add(match[0].replace(/[.,;]+$/g, ""));
  return contacts;
}

function sourceFileOnly(source) {
  return normalizeSpaces(source).replace(/\s+\(https?:\/\/.*?\)\s*$/i, "");
}

function scoreLead({ name = "", role, text, cancerExpertise = "No", manualScore }) {
  if (Number.isFinite(manualScore)) return manualScore;
  const directCancer = DIRECT_CANCER_CARE_RE.test(text);
  const kruseProtocol = hasKruseProtocol(text);
  const selfPractice = SELF_PRACTICE_RE.test(text);
  const researchOnly = RESEARCH_ONLY_RE.test(text) && !directCancer && !selfPractice;
  const isDoctor = role === "Doctor";
  const namedClinic = /\b(?:Clinic|Center|Centre|Hospital|Institute|Therapy|Therapeutics|Medical|Health)\b/i.test(name);

  if (directCancer && kruseProtocol && (isDoctor || namedClinic) && !researchOnly) return 8;
  if (directCancer && kruseProtocol && selfPractice) return 8;
  if (directCancer && kruseProtocol) return 8;
  if (directCancer && (isDoctor || namedClinic)) return 7;
  if (cancerExpertise === "Yes" && kruseProtocol && (isDoctor || namedClinic || role === "Lab")) return 7;
  if (cancerExpertise === "Yes" && kruseProtocol) return 6;
  if (kruseProtocol && (isDoctor || namedClinic || role === "Lab" || selfPractice)) return 5;
  if (cancerExpertise === "Yes" && (isDoctor || namedClinic)) return 5;
  if (cancerExpertise === "Yes") return 4;
  if (isDoctor || namedClinic || role === "Lab") return 3;
  return 2;
}

function triageTier(score, text) {
  if (score >= 9) return "A - Strong cancer/Kruse lead";
  if (score >= 7) return "B - Cancer/Kruse lead; verify details";
  if (score >= 5) return "C - Relevant practitioner/clinic/lab lead";
  if (CANCER_RE.test(text)) return "D - Weak or indirect cancer mention";
  return "E - Low-priority clinical mention";
}

function defaultSummary(name, role, text, protocols) {
  const cancerText = DIRECT_CANCER_CARE_RE.test(text)
    ? "Direct cancer-care language is present."
    : CANCER_RE.test(text)
      ? "Cancer is mentioned, but direct patient-care evidence is limited."
      : "No direct cancer-care evidence was extracted.";
  const protocolText = protocols.length
    ? `Kruse-aligned or adjacent protocols mentioned: ${protocols.join(", ")}.`
    : "No specific Kruse-aligned protocol was extracted in the retained evidence.";
  return `${name} is a ${role.toLowerCase()} lead from the forum extraction. ${cancerText} ${protocolText}`;
}

function defaultReason(score, role, text) {
  const flags = [];
  if (DIRECT_CANCER_CARE_RE.test(text)) flags.push("direct cancer-care language");
  if (hasKruseProtocol(text)) flags.push("Kruse-aligned protocol cues");
  if (SELF_PRACTICE_RE.test(text)) flags.push("self-described practice/patient work");
  if (RESEARCH_ONLY_RE.test(text) && !SELF_PRACTICE_RE.test(text)) flags.push("research/media/book context");
  if (!flags.length) flags.push("generic clinical/practitioner mention");
  return `${score}/10 based on ${flags.join(", ")} and role classified as ${role}.`;
}

function addLead(map, input) {
  const name = canonicalDisplayName(input.name);
  if (isBadName(name)) return;
  const key = canonicalKey(name);
  if (!key) return;
  const text = cleanField([input.evidence, input.summary, input.reason, input.source].filter(Boolean).join(" "), 12000);
  const role = inferRole(name, text, input.role);
  const cancerExpertise = input.cancerExpertise === "Yes" || CANCER_RE.test(text) ? "Yes" : "No";
  const protocols = protocolsIn(text);
  const score = scoreLead({ name, role, text, cancerExpertise, manualScore: input.score });
  if (score < 4 && !input.forceInclude) return;

  const existing =
    map.get(key) ||
    {
      name,
      role,
      score: 0,
      cancerExpertise: "No",
      protocols: new Set(),
      evidence: [],
      sources: new Set(),
      contacts: new Set(),
      summaries: [],
      reasons: [],
      reviewNotes: new Set(),
    };

  if (roleRank(role) > roleRank(existing.role)) existing.role = role;
  existing.score = Math.max(existing.score, score);
  if (cancerExpertise === "Yes") existing.cancerExpertise = "Yes";
  for (const protocol of protocols) existing.protocols.add(protocol);
  if (input.evidence && existing.evidence.length < 5) existing.evidence.push(cleanField(input.evidence, 1500));
  if (input.source) {
    for (const source of splitList(input.source).map(sourceFileOnly)) existing.sources.add(source);
  }
  if (input.contact) {
    for (const contact of splitList(input.contact)) if (!/^Unknown$/i.test(contact)) existing.contacts.add(contact);
  }
  for (const contact of contactSet(text)) existing.contacts.add(contact);
  if (input.forceInclude && input.summary) existing.summaries = [cleanField(input.summary, 1400)];
  else if (input.summary && existing.summaries.length < 3) existing.summaries.push(cleanField(input.summary, 1400));
  if (input.forceInclude && input.reason) existing.reasons = [cleanField(input.reason, 1400)];
  else if (input.reason && existing.reasons.length < 3) existing.reasons.push(cleanField(input.reason, 1400));
  if (input.review) existing.reviewNotes.add(cleanField(input.review, 1000));
  map.set(key, existing);
}

function addBasePractitioners(map, rows) {
  for (const row of rows) {
    const name = row.Name;
    const evidence = row["Alignment Evidence"] || "";
    const source = row["Source Link (specific file)"] || row["Source Link"] || "";
    const role = row["Role (Doctor/Coach/Lab/Other)"] || row.Role || "Other";
    const cancerExpertise = row["Cancer Expertise (Yes/No)"] || row["Cancer Expertise"] || "No";
    const score = scoreLead({ name, role, text: `${evidence} ${source}`, cancerExpertise });
    addLead(map, {
      name,
      role,
      cancerExpertise,
      source,
      contact: row["Contact Details (emails/links)"] || "",
      evidence,
      score,
      summary: defaultSummary(canonicalDisplayName(name), role, `${evidence} ${source}`, protocolsIn(`${evidence} ${source}`)),
      reason: defaultReason(score, role, `${evidence} ${source}`),
    });
  }
}

function listThreadFiles(dir) {
  return fsSync.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name));
}

function addAuthorClinicalLeads(map) {
  const files = listThreadFiles(THREAD_DIR);
  let fileIndex = 0;
  for (const file of files) {
    fileIndex += 1;
    if (fileIndex % 1000 === 0) console.error("high-recall: author scan file", fileIndex, "of", files.length, path.basename(file));
    const rel = path.relative(ROOT, file).replaceAll(path.sep, "/");
    const lines = fsSync.readFileSync(file, "utf8").split(/\r?\n/);
    let post = null;
    function finish() {
      if (!post) return;
      const ownText = stripMarkdown(post.ownLines.join(" "));
      const scanText = ownText.slice(0, 2500);
      const lower = scanText.toLowerCase();
      if (!/(clinic|practice|patients?|clients?|practitioner|doctor|physician|surgeon|oncolog|cancer|DDW|deuterium|acupuncturist|building biologist)/i.test(scanText)) return;
      const selfRelevant =
        lower.includes("my clinic") ||
        lower.includes("our clinic") ||
        lower.includes("my practice") ||
        lower.includes("our practice") ||
        lower.includes("own and operate") ||
        lower.includes("my patients") ||
        lower.includes("our patients") ||
        lower.includes("my clients") ||
        lower.includes("our clients") ||
        lower.includes("referred patients") ||
        lower.includes("practitioners forum") ||
        lower.includes("skilled acupuncturist") ||
        lower.includes("building biologist") ||
        /work(?:ing)? with.{0,80}(patients|clinic|clients)/i.test(scanText) ||
        /i (?:treat|see).{0,80}(patients|clients)/i.test(scanText);
      const directCancerRelevant =
        lower.includes("cancer clinic") ||
        lower.includes("stage 4 cancer") ||
        lower.includes("cancer patients") ||
        lower.includes("lowered cancer markers") ||
        lower.includes("oncologist") ||
        lower.includes("oncology");
      const doctorRelevant =
        /^(?:Dr\.|Doctor\b)/i.test(post.author) &&
        (lower.includes("cancer") || lower.includes("ddw") || lower.includes("deuterium") || lower.includes("sun") || lower.includes("emf"));
      const relevant = selfRelevant || directCancerRelevant || doctorRelevant;
      if (!relevant) return;
      const cancerExpertise = lower.includes("cancer") || lower.includes("oncolog") || lower.includes("tumor") || lower.includes("tumour") ? "Yes" : "No";
      const role = inferRole(post.author, scanText, "Other");
      const source = `${rel}${post.source ? ` (${post.source})` : ""}`;
      const score = scoreLead({ name: post.author, role, text: scanText, cancerExpertise });
      addLead(map, {
        name: post.author,
        role,
        cancerExpertise,
        source,
        evidence: `${source}: ${scanText.slice(0, 1200)}`,
        score,
        summary: defaultSummary(post.author, role, scanText, protocolsIn(scanText)),
        reason: defaultReason(score, role, scanText),
        review: role === "Other" ? "Review Needed: forum handle/self-description; verify credentials and clinic identity." : "",
      });
    }
    for (const line of lines) {
      const heading = line.match(/^###\s+(.+?)\s+.*?\d{4}-\d{2}-\d{2}T/);
      if (heading) {
        finish();
        post = { author: stripMarkdown(heading[1]), source: "", lines: [], ownLines: [] };
        continue;
      }
      if (!post) continue;
      const source = line.match(/^\*\*Source:\*\*\s+<([^>]+)>/);
      if (source) post.source = source[1];
      post.lines.push(line);
      if (!line.trimStart().startsWith(">")) post.ownLines.push(line);
    }
    finish();
  }
}

function buildPractitioners(baseRows) {
  const map = new Map();
  console.error("high-recall: adding base practitioner rows", baseRows.length);
  addBasePractitioners(map, baseRows);
  console.error("high-recall: after base rows", map.size);
  console.error("high-recall: scanning author clinical leads");
  addAuthorClinicalLeads(map);
  console.error("high-recall: after author leads", map.size);
  for (const lead of MANUAL_LEADS) addLead(map, { ...lead, forceInclude: true });
  console.error("high-recall: after manual leads", map.size);

  const rows = [...map.values()]
    .map((lead) => {
      const evidenceText = lead.evidence.join(" | ");
      const summary = lead.summaries.length
        ? lead.summaries.join(" ")
        : defaultSummary(lead.name, lead.role, evidenceText, [...lead.protocols]);
      const reason = lead.reasons.length ? lead.reasons.join(" ") : defaultReason(lead.score, lead.role, evidenceText);
      const reviewNotes =
        lead.reviewNotes.size
          ? [...lead.reviewNotes].join(" | ")
          : lead.score >= 8
            ? "High-priority lead; verify current credentials/contact before outreach."
            : "Use source evidence to decide whether this is a contactable lead or only a cited resource.";
      return {
        "Name": lead.name,
        "Role (Doctor/Coach/Lab/Other)": lead.role,
        "Triage Tier": triageTier(lead.score, `${summary} ${evidenceText}`),
        "Cancer/Kruse Protocol Summary": cleanField(summary, 2600),
        "Alignment Evidence": cleanField(evidenceText, 3200),
        "Cancer Expertise (Yes/No)": lead.cancerExpertise,
        "Contact Details (emails/links)": lead.contacts.size ? cleanField([...lead.contacts].join("; "), 3000) : "Unknown",
        "Source Link (specific file)": cleanField([...lead.sources].join("; "), 32000),
        "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": lead.score,
        "Reasoning / Why This Score": cleanField(reason, 2200),
        "Review Notes": cleanField(reviewNotes, 1200),
      };
    })
    .sort((a, b) => {
      const scoreDiff =
        b["Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)"] -
        a["Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)"];
      if (scoreDiff) return scoreDiff;
      return a.Name.localeCompare(b.Name);
    });
  console.error("high-recall: final practitioner rows", rows.length);
  return rows;
}

function cleanPatientHandle(value) {
  const handle = normalizeSpaces(xmlSafe(value))
    .replace(/([a-z])Dr\..*$/g, "$1")
    .replace(/\s+said:?$/i, "")
    .trim();
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
    const existing =
      merged.get(key) ||
      {
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
    if (summary !== "Unknown" && existing.summaries.length < 5 && !existing.summaries.includes(summary)) existing.summaries.push(summary);
    merged.set(key, existing);
  }

  return [...merged.values()]
    .map((row) => {
      const cancerTypes = row.cancerTypes.size ? [...row.cancerTypes].sort().join("; ") : "Unknown";
      const protocols = row.protocols.size ? [...row.protocols].sort().join("; ") : "Unknown";
      const outcome =
        row.success === "Yes"
          ? "At least one extracted mention described a successful outcome."
          : row.success === "Partial"
            ? "At least one extracted mention described partial improvement, stability, or ongoing response."
            : "No clear success outcome was extracted.";
      const redactedNote = row.redacted
        ? " The source markdown had already replaced the original username with [email redacted], so separate original users cannot be reconstructed from these files."
        : "";
      const evidenceSentence = row.summaries.length
        ? `Representative extracted evidence: ${row.summaries.slice(0, 2).join(" ")}`
        : "Representative extracted evidence was not specific beyond the cancer mention.";
      return {
        "Patient Handle": row.handle,
        "Cancer Type": cancerTypes,
        "Success Story (Yes/No/Partial)": row.success,
        "Protocols Used (e.g., DDW)": cleanField(protocols, 3500),
        "Detailed Summary (2-3 sentences)": cleanField(
          `${row.handle} is consolidated from ${row.mentionCount} extracted cancer-related mention(s); cancer type(s): ${cancerTypes}. Protocols/treatments mentioned include: ${protocols}. ${outcome}${redactedNote} ${evidenceSentence}`,
          2600
        ),
        "Source Link": cleanField([...row.sources].sort().join("; "), 32000),
      };
    })
    .sort((a, b) => a["Patient Handle"].localeCompare(b["Patient Handle"]));
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

function writeSheet(sheet, headers, rows, tableName, widths = []) {
  const values = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ""))];
  const lastColumn = columnLetter(headers.length - 1);
  const lastRow = values.length;
  sheet.getRange(`A1:${lastColumn}${lastRow}`).values = values;
  sheet.getRange(`A1:${lastColumn}1`).format = {
    fill: "#1F4E78",
    font: { bold: true, color: "#FFFFFF" },
  };
  sheet.getRange(`A1:${lastColumn}${lastRow}`).format.wrapText = false;
  sheet.getRange(`A1:${lastColumn}1`).format.wrapText = true;
  sheet.getRange(`A1:${lastColumn}1`).format.rowHeight = 54;
  for (let i = 0; i < widths.length; i += 1) {
    sheet.getRange(`${columnLetter(i)}:${columnLetter(i)}`).format.columnWidth = widths[i];
  }
  sheet.tables.add(`A1:${lastColumn}${lastRow}`, true, tableName);
}

async function main() {
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  const input = JSON.parse(await fs.readFile(INPUT_PATH, "utf8"));
  console.error("high-recall: input loaded");
  const practitioners = buildPractitioners(input.practitioners);
  console.error("high-recall: merging patients");
  const patients = mergePatients(input.cancerPatients);
  console.error("high-recall: writing clean json");

  await fs.writeFile(
    CLEAN_DATA_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        practitioner_rule:
          "High-recall lead table. Includes cleaned named doctors/clinics/labs from the full extraction plus forum handles with self-described clinical/practitioner evidence. Scores and triage tiers separate strong cancer/Kruse leads from weak/indirect mentions.",
        patient_rule: "One row per cleaned forum handle.",
        practitioner_rows: practitioners.length,
        cancer_patient_rows: patients.length,
        practitioners,
        cancerPatients: patients,
      },
      null,
      2
    )
  );

  const workbook = Workbook.create();
  const practitionersSheet = workbook.worksheets.add("Practitioners");
  const patientsSheet = workbook.worksheets.add("Cancer Patients");
  writeSheet(practitionersSheet, PRACTITIONER_HEADERS, practitioners, "PractitionersTable", [26, 18, 24, 76, 88, 18, 42, 78, 18, 76, 54]);
  writeSheet(patientsSheet, PATIENT_HEADERS, patients, "CancerPatientsTable", [28, 30, 24, 54, 110, 90]);

  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(OUTPUT_PATH);

  console.log(
    JSON.stringify(
      {
        output: OUTPUT_PATH,
        clean_data: CLEAN_DATA_PATH,
        practitioner_rows: practitioners.length,
        cancer_patient_rows: patients.length,
        score_counts: practitioners.reduce((acc, row) => {
          const score = row["Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)"];
          acc[score] = (acc[score] || 0) + 1;
          return acc;
        }, {}),
        acuhealth: practitioners.find((row) => row.Name === "AcuHealth"),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
