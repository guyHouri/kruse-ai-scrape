import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const ROOT = process.cwd();
const PROCESSED_DIR = path.join(ROOT, "processed_mds");
const LOG_PATH = path.join(ROOT, "processing_log.json");
const OUTPUT_PATH = path.join(ROOT, "analysis_work", "clinical_extraction.json");
const STATE_PATH = path.join(ROOT, "analysis_work", "processing_state.json");

const CANCER_TYPE_PATTERNS = [
  ["Brain cancer", /\b(?:brain\s+(?:cancer|tumou?r)|glioblastoma|glioma|astrocytoma)\b/i],
  ["Breast cancer", /\b(?:breast\s+cancer|mastectomy|lumpectomy|dcis|brca)\b/i],
  ["Thyroid cancer", /\bthyroid\s+cancer\b/i],
  ["Skin cancer / melanoma", /\b(?:skin\s+cancer|melanoma|basal\s+cell|squamous\s+cell)\b/i],
  ["Prostate cancer", /\bprostate\s+cancer\b/i],
  ["Colon / colorectal / bowel cancer", /\b(?:colon|colorectal|bowel|rectal)\s+cancer\b/i],
  ["Lung cancer", /\blung\s+cancer\b/i],
  ["Ovarian cancer", /\bovarian\s+cancer\b|\bovaries\b.{0,40}\b(?:cancer|precancerous)\b/i],
  ["Cervical cancer", /\bcervical\s+cancer\b/i],
  ["Uterine / endometrial cancer", /\b(?:uterine|endometrial)\s+cancer\b/i],
  ["Pancreatic cancer", /\bpancreatic\s+cancer\b/i],
  ["Liver cancer", /\bliver\s+cancer\b/i],
  ["Kidney cancer", /\bkidney\s+cancer\b/i],
  ["Bladder cancer", /\bbladder\s+cancer\b/i],
  ["Stomach / gastric cancer", /\b(?:stomach|gastric)\s+cancer\b/i],
  ["Esophageal cancer", /\besophageal\s+cancer\b/i],
  ["Spinal cancer", /\bspinal\s+cancer\b/i],
  ["Bone cancer", /\bbone\s+cancer\b/i],
  ["Lymphoma", /\blymphoma\b/i],
  ["Leukemia", /\bleuk(?:a)?emia\b/i],
  ["Myeloma", /\bmyeloma\b/i],
  ["Sarcoma", /\bsarcoma\b/i],
  ["Carcinoma", /\bcarcinoma\b/i],
  ["Tumor / tumour", /\btumou?r\b/i],
  ["Precancerous cells", /\bprecancer(?:ous)?\b/i],
  ["Unspecified cancer", /\bcancers?\b/i],
];

const PROTOCOL_PATTERNS = [
  ["DDW / deuterium depletion", /\b(?:DDW|deuterium(?:\s+deplet(?:ed|ion))?|Preventa|Qlarivia|Litewater)\b/i],
  ["Cold thermogenesis / CT", /\b(?:cold thermogenesis|\bCT\b|ice bath|cold tub|cold water|cold pack)\b/i],
  ["Sun / sunrise / UV", /\b(?:sunrise|sunlight|sun\b|UV\b|UVA|UVB|solar|heliotherapy)\b/i],
  ["Epi-paleo / seafood / DHA", /\b(?:epi-?paleo|seafood|oysters?|DHA)\b/i],
  ["Ketogenic diet", /\b(?:keto|ketogenic|ketosis)\b/i],
  ["nnEMF reduction", /\b(?:nnEMF|EMF|RF|microwave|Wi-?Fi|blue light|blue blockers?)\b/i],
  ["Grounding", /\b(?:grounding|earthing)\b/i],
  ["Melatonin / circadian protocol", /\b(?:melatonin|circadian|darkness|dark room)\b/i],
  ["Red light / infrared", /\b(?:red light|infrared|IR-A|photobiomodulation|PBM)\b/i],
  ["Sauna / heat", /\bsauna\b/i],
  ["Hyperbaric oxygen / HBOT", /\b(?:HBOT|hyperbaric)\b/i],
  ["Ozone / H2O2", /\b(?:ozone|H2O2|hydrogen peroxide)\b/i],
  ["Mistletoe", /\bmistletoe\b/i],
  ["Methylene blue", /\bmethylene blue\b/i],
  ["DCA / 3BP", /\b(?:dichloroacetate|DCA|3BP|3-bromopyruvate)\b/i],
  ["Chemotherapy", /\bchemo(?:therapy)?\b/i],
  ["Radiation therapy", /\b(?:radiation|radiotherapy)\b/i],
  ["Surgery", /\b(?:surgery|surgical|removed|mastectomy|lumpectomy|thyroid removed)\b/i],
  ["Immunotherapy", /\b(?:immunotherapy|Keytruda|Opdivo|Herceptin)\b/i],
];

const CANCER_CUE_RE =
  /\b(?:cancers?|oncolog(?:y|ist|ical)?|tumou?rs?|malignan(?:t|cy)?|metasta(?:sis|tic|sized)?|carcinoma|sarcoma|lymphoma|leuk(?:a)?emia|myeloma|melanoma|glioblastoma|glioma|chemo(?:therapy)?|radiation|radiotherapy|remission|neoplasm|precancer(?:ous)?|mastectomy|lumpectomy|BRCA|NED|biopsy|biopsies|immunotherapy|tumou?r\s+marker|stage\s+(?:I{1,3}|IV|[1-4])\b|DDW|deuterium)\b/i;

const PATIENT_CANCER_RE =
  /\b(?:cancers?|oncolog(?:y|ist|ical)?|tumou?rs?|malignan(?:t|cy)?|metasta(?:sis|tic|sized)?|carcinoma|sarcoma|lymphoma|leuk(?:a)?emia|myeloma|melanoma|glioblastoma|glioma|chemo(?:therapy)?|radiation|radiotherapy|remission|neoplasm|precancer(?:ous)?|mastectomy|lumpectomy|BRCA|NED|biopsy|biopsies|immunotherapy|tumou?r\s+marker|stage\s+(?:I{1,3}|IV|[1-4])\b)\b/i;

const PRACTITIONER_CUE_RE =
  /\b(?:Dr\.?|doctor|physician|practitioner|coach|clinician|chiropractor|dentist|surgeon|oncologist|naturopath|therapist|clinic|labs?|laboratory|diagnostics|hospital|institute|center|centre|MD|M\.D\.|DO|D\.O\.|ND|N\.D\.|DC|D\.C\.)\b/i;

const SUBTLE_REVIEW_RE =
  /\b(?:mets|NED|neoplasm|mastectomy|lumpectomy|immunotherapy|tumou?r\s+marker|PSA|BRCA|stage\s+(?:I{1,3}|IV|[1-4])\b|PET\s+scan|onc\b|radiotherapy|tamoxifen|aromatase inhibitor|Keytruda|Herceptin|biopsy|biopsies)\b/i;

const GENERAL_RESEARCH_RE =
  /\b(?:study|studies|paper|article|book|podcast|news|research|risk|causes?|linked to|associated with|metabolic disease|warburg|cell line|cellular|mice|rats|trial|patent|abstract)\b/i;

const FIRST_PERSON_RE =
  /\b(?:I|me|my|mine|I've|I’ve|I'm|I’m|I was|I am|diagnosed me|my diagnosis|my oncologist|my doctor|my surgeon)\b/i;

const RELATION_RE =
  /\b(?:my\s+)?(mother|mom|mum|father|dad|wife|husband|sister|brother|daughter|son|grandmother|grandma|grandfather|grandpa|friend|aunt|uncle|cousin|partner|fianc[eé]e?|girlfriend|boyfriend|child|patient|client)\b/i;

const PATIENT_ACTION_RE =
  /\b(?:diagnosed|dx(?:'d)?|had|has|have|having|suffer(?:ed|ing)?|treated|treatment|undergoing|survivor|survived|died|passed away|lost|remission|cancer[- ]free|tumou?r|chemo|radiation|oncologist|mastectomy|lumpectomy|thyroid removed|precancerous)\b/i;

const SUCCESS_YES_RE =
  /\b(?:cured|remission|NED|no evidence of disease|no evidence|beat|beaten|survivor|survived|recovered|cancer[- ]free|clear scan|tumou?r(?:s)?\s+(?:gone|disappeared|resolved))\b/i;

const SUCCESS_PARTIAL_RE =
  /\b(?:improved|improvement|stable|shr(?:a|u)nk|shrinking|slowed|better|respond(?:ed|ing)|helped|partial|progress)\b/i;

const SUCCESS_NO_RE =
  /\b(?:died|passed away|lost\s+(?:her|him|them|my|our)?|terminal|stage\s+(?:4|IV)|metasta(?:sis|tic|sized)|worse|recurrence|returned|palliative)\b/i;

const KNOWN_LABS = [
  "LabCorp",
  "Quest Diagnostics",
  "Genova Diagnostics",
  "Doctor's Data",
  "Doctors Data",
  "DUTCH",
  "Precision Analytical",
  "SpectraCell",
  "Cleveland HeartLab",
  "ZRT Laboratory",
  "Cyrex Labs",
  "Vibrant Wellness",
  "Great Plains Laboratory",
  "BioHealth Laboratory",
  "Life Extension",
  "23andMe",
  "Promethease",
];

const NORMAL_NAME_MAP = new Map([
  ["dr jack", "Dr. Jack Kruse"],
  ["dr. jack", "Dr. Jack Kruse"],
  ["dr kruse", "Dr. Jack Kruse"],
  ["dr. kruse", "Dr. Jack Kruse"],
  ["dr jack kruse", "Dr. Jack Kruse"],
  ["dr. jack kruse", "Dr. Jack Kruse"],
  ["jack kruse", "Dr. Jack Kruse"],
  ["dr rohen kapur", "Dr. Rohen Kapur"],
  ["dr. rohen kapur", "Dr. Rohen Kapur"],
  ["rohen kapur", "Dr. Rohen Kapur"],
  ["dr sarah myhill", "Dr. Sarah Myhill"],
  ["dr. sarah myhill", "Dr. Sarah Myhill"],
  ["dr myhill", "Dr. Sarah Myhill"],
  ["dr. myhill", "Dr. Sarah Myhill"],
  ["dr dietrich klinghardt", "Dr. Dietrich Klinghardt"],
  ["dr. dietrich klinghardt", "Dr. Dietrich Klinghardt"],
  ["dr klinghardt", "Dr. Dietrich Klinghardt"],
  ["dr. klinghardt", "Dr. Dietrich Klinghardt"],
]);

const FALSE_NAME_RE =
  /\b(?:dr|doctor)\s+(?:who|google|ozone|bat|shit|pepper|bergamot|water|light|sun|cold|kruses?|jacks?)\b/i;

function toRel(filePath) {
  return path.relative(ROOT, filePath).replaceAll(path.sep, "/");
}

function normalizeSpaces(value) {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdown(value) {
  return normalizeSpaces(
    value
      .replace(/!\[[^\]]*]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/[*_`>#]+/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
  );
}

function sentenceClip(value, max = 420) {
  const cleaned = stripMarkdown(value).replace(/\|/g, " ");
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trim()}…`;
}

function cleanEntityName(rawName) {
  if (!rawName) return null;
  let name = stripMarkdown(rawName)
    .replace(/\bsaid:?$/i, "")
    .replace(/\bwrote:?$/i, "")
    .replace(/\b(?:MD|M\.D\.|DO|D\.O\.|ND|N\.D\.|DC|D\.C\.|PhD|Ph\.D\.|RN|MSc)\b\.?/gi, "")
    .replace(/[,:;()[\]{}]+$/g, "")
    .replace(/['’]s\b/g, "")
    .trim();

  if (!name || name.length < 3 || name.length > 90) return null;
  if (FALSE_NAME_RE.test(name)) return null;
  if (!/^(?:Dr\.?\s+)?[A-Z0-9]/.test(name)) return null;
  if (/\b(?:about|above|after|again|also|and|another|because|before|below|between|could|doesn|during|from|get|getting|give|going|have|help|into|make|need|other|said|should|that|their|there|these|they|this|those|through|under|were|what|when|where|which|while|with|would|your)\b/i.test(name) && !/\b(?:Clinic|Center|Centre|Institute|Hospital|Labs?|Laborator|Diagnostics|Medical|MD|PhD|Dr\.?)\b/.test(name)) return null;
  if (/^(?:The|This|That|These|Those|What|Where|When|Why|How|And|But|For|With)$/i.test(name)) return null;

  const key = name.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  return NORMAL_NAME_MAP.get(key) || name;
}

function canonicalEntityKey(name) {
  return name
    .toLowerCase()
    .replace(/\bdr\.?\s+/g, "")
    .replace(/\bdoctor\s+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function roleRank(role) {
  return { Doctor: 4, Lab: 3, Coach: 2, Other: 1 }[role] || 0;
}

function inferRole(name, context) {
  const haystack = `${name} ${context}`.toLowerCase();
  if (/\b(lab|laborator|diagnostics|heartlab|spectracell|genova|quest|labcorp|cyrex|vibrant|zrt|dutch|23andme|promethease)\b/.test(haystack)) {
    return "Lab";
  }
  if (/\b(coach|coaching)\b/.test(haystack)) return "Coach";
  if (/\b(dr\.?|doctor|physician|surgeon|oncologist|dentist|chiropractor|naturopath|md|m\.d\.|do|d\.o\.|nd|n\.d\.|dc|d\.c\.)\b/.test(haystack)) {
    return "Doctor";
  }
  return "Other";
}

function findCancerTypes(text) {
  const found = [];
  for (const [label, re] of CANCER_TYPE_PATTERNS) {
    if (re.test(text)) found.push(label);
  }
  if (found.length === 0 && PATIENT_CANCER_RE.test(text)) found.push("Unknown");
  return [...new Set(found)];
}

function findProtocols(text) {
  const found = [];
  for (const [label, re] of PROTOCOL_PATTERNS) {
    if (re.test(text)) found.push(label);
  }
  return [...new Set(found)];
}

function findContacts(text) {
  const contacts = new Set();
  for (const match of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    contacts.add(match[0]);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s>)\]]+/gi)) {
    contacts.add(match[0].replace(/[.,;]+$/g, ""));
  }
  return [...contacts];
}

function classifySuccess(text) {
  if (SUCCESS_YES_RE.test(text)) return "Yes";
  if (SUCCESS_PARTIAL_RE.test(text)) return "Partial";
  if (SUCCESS_NO_RE.test(text)) return "No";
  return "No";
}

function isCanonicalThread(filePath) {
  const rel = toRel(filePath);
  return rel.startsWith("processed_mds/threads/");
}

async function listMarkdownFiles(dir) {
  const files = [];
  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(full);
      }
    }
  }
  await walk(dir);
  return files;
}

function extractPractitionerEntities(line, author) {
  const candidates = new Set();
  const cleanLine = stripMarkdown(line);

  for (const match of cleanLine.matchAll(/\bDr\.?\s+(?:[A-Z][A-Za-z'’.-]+|[A-Z]\.)(?:\s+(?:[A-Z][A-Za-z'’.-]+|[A-Z]\.)){0,4}/g)) {
    const name = cleanEntityName(match[0]);
    if (name) candidates.add(name);
  }

  for (const match of cleanLine.matchAll(/\b([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){1,4}),?\s+(M\.?D\.?|D\.?O\.?|N\.?D\.?|D\.?C\.?|Ph\.?D\.?|RN|MSc)\b/g)) {
    const name = cleanEntityName(`${match[1]} ${match[2]}`);
    if (name) candidates.add(name);
  }

  for (const match of cleanLine.matchAll(/\b(?:[Dd]octor|[Pp]hysician|[Pp]ractitioner|[Cc]oach|[Cc]hiropractor|[Dd]entist|[Ss]urgeon|[Oo]ncologist|[Nn]aturopath|[Tt]herapist)\s+(?:named\s+)?([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,4})/g)) {
    const name = cleanEntityName(match[1]);
    if (name) candidates.add(name);
  }

  for (const match of cleanLine.matchAll(/\b([A-Z][A-Za-z0-9&'’.-]+(?:\s+(?:of|and|the|for|[A-Z][A-Za-z0-9&'’.-]+)){0,6}\s+(?:Labs?|Laboratories|Clinic|Clinics|Center|Centre|Institute|Hospital|Diagnostics|Medical|Wellness|Health|Therapy|Therapeutics|Pathology|Pharmacy))\b/g)) {
    const name = cleanEntityName(match[1]);
    if (name) candidates.add(name);
  }

  for (const lab of KNOWN_LABS) {
    if (new RegExp(`\\b${lab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(cleanLine)) {
      candidates.add(lab);
    }
  }

  const authorName = cleanEntityName(author || "");
  if (authorName && /^(?:Dr\.?\s+|.*\b(?:MD|M\.D\.|DO|D\.O\.|ND|N\.D\.|DC|D\.C\.)\b)/i.test(authorName)) {
    candidates.add(authorName);
  }

  return [...candidates];
}

function patientLabelFromLine(line, author) {
  const cleanLine = stripMarkdown(line);
  const relation = cleanLine.match(RELATION_RE)?.[1];
  const firstPerson = FIRST_PERSON_RE.test(cleanLine);

  if (relation && !/^my$/i.test(relation)) {
    return `${relation.toLowerCase()} of ${author || "Unknown"}`;
  }
  if (firstPerson && author) return author;
  return author ? `Unknown (reported by ${author})` : "Unknown";
}

function isLikelyPatientLine(line) {
  const cleanLine = stripMarkdown(line);
  if (!PATIENT_CANCER_RE.test(cleanLine)) return false;
  if (!PATIENT_ACTION_RE.test(cleanLine)) return false;
  if (FIRST_PERSON_RE.test(cleanLine) || RELATION_RE.test(cleanLine)) return true;
  if (/\b(?:diagnosed|dx(?:'d)?|treated|undergoing|survivor|remission|died|passed away|lost)\b.{0,80}\b(?:cancer|tumou?r|carcinoma|lymphoma|leukemia|melanoma|sarcoma)\b/i.test(cleanLine)) {
    return true;
  }
  if (GENERAL_RESEARCH_RE.test(cleanLine)) return false;
  return false;
}

function addPractitioner(practitioners, name, evidence) {
  const key = canonicalEntityKey(name);
  if (!key) return;
  const existing =
    practitioners.get(key) ||
    {
      name,
      role: "Other",
      alignmentEvidence: [],
      cancerExpertise: "No",
      contacts: new Set(),
      sourceLinks: new Set(),
      evidenceCount: 0,
      bestContext: "",
      confidence: 1,
    };

  const context = `${evidence.snippet} ${evidence.author || ""}`;
  const inferredRole = inferRole(name, context);
  if (roleRank(inferredRole) > roleRank(existing.role)) existing.role = inferredRole;

  const cancerContext = CANCER_CUE_RE.test(context) || /\boncolog/.test(context.toLowerCase());
  if (cancerContext) existing.cancerExpertise = "Yes";

  const contacts = findContacts(context);
  for (const contact of contacts) existing.contacts.add(contact);
  existing.sourceLinks.add(evidence.sourceLink);
  existing.evidenceCount += 1;

  const evidenceText = `${evidence.sourceLink}: ${sentenceClip(evidence.snippet, 220)}`;
  if (existing.alignmentEvidence.length < 5 && !existing.alignmentEvidence.includes(evidenceText)) {
    existing.alignmentEvidence.push(evidenceText);
  }
  if (!existing.bestContext || (cancerContext && !CANCER_CUE_RE.test(existing.bestContext))) {
    existing.bestContext = context;
  }

  let confidence = 1;
  if (existing.role === "Doctor") confidence = 6;
  if (existing.role === "Lab") confidence = 5;
  if (existing.role === "Coach") confidence = 3;
  if (existing.cancerExpertise === "Yes") confidence += existing.role === "Doctor" ? 3 : 2;
  if (/\boncolog(?:y|ist)|cancer\s+(?:clinic|center|centre)|treat(?:s|ed|ing)?\s+cancer/i.test(context)) confidence = Math.max(confidence, 9);
  if (/posted in Jack Kruse forum/i.test(context)) confidence = Math.max(confidence, existing.role === "Doctor" ? 6 : confidence);
  existing.confidence = Math.max(existing.confidence, Math.min(confidence, 10));

  practitioners.set(key, existing);
}

function addPatient(patients, record) {
  const cancerType = record.cancerType || "Unknown";
  const key = `${record.patientHandle.toLowerCase()}|${cancerType.toLowerCase()}`;
  const existing =
    patients.get(key) ||
    {
      patientHandle: record.patientHandle,
      cancerType,
      successStory: "No",
      protocols: new Set(),
      summaries: [],
      sourceLinks: new Set(),
      evidenceCount: 0,
    };

  const successRank = { No: 1, Partial: 2, Yes: 3 };
  if (successRank[record.successStory] > successRank[existing.successStory]) {
    existing.successStory = record.successStory;
  }
  for (const protocol of record.protocols) existing.protocols.add(protocol);
  existing.sourceLinks.add(record.sourceLink);
  existing.evidenceCount += 1;
  const summary = sentenceClip(record.summary, 360);
  if (existing.summaries.length < 4 && !existing.summaries.includes(summary)) {
    existing.summaries.push(summary);
  }
  patients.set(key, existing);
}

function buildPatientSummary({ patientHandle, cancerTypes, protocols, success, snippet, sourceLink }) {
  const typeText = cancerTypes.length ? cancerTypes.join(", ") : "Unknown cancer type";
  const protocolText = protocols.length ? protocols.join(", ") : "Unknown";
  const outcomeText =
    success === "Yes"
      ? "The wording suggests a success or remission story."
      : success === "Partial"
        ? "The wording suggests partial improvement or disease stability."
        : "No clear success outcome is documented in the extracted context.";
  return `${patientHandle} is mentioned with ${typeText}. Protocols or treatments mentioned in the same post include ${protocolText}. ${outcomeText} Evidence from ${sourceLink}: ${snippet}`;
}

async function scanFile(filePath, index, total, stores, streamLogEntry) {
  const rel = toRel(filePath);
  const canonical = isCanonicalThread(filePath);
  const entitiesFound = new Set();
  const filePractitionerNames = new Set();
  const filePatientLabels = new Set();
  let cancerCueCount = 0;
  let practitionerCueCount = 0;
  let patientMentionCount = 0;
  let currentAuthor = "Unknown";
  let currentSource = "";
  let threadTitle = "";
  let post = null;

  async function finishPost() {
    if (!post || !canonical) return;
    const postText = post.lines.join("\n");
    if (!PATIENT_CANCER_RE.test(postText)) return;
    const protocols = findProtocols(postText);
    const contactContext = post.lines.slice(0, 40).join(" ");
    const lines = post.lines;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!isLikelyPatientLine(line)) continue;
      const context = [lines[i - 2], lines[i - 1], line, lines[i + 1], lines[i + 2]]
        .filter(Boolean)
        .join(" ");
      const cancerTypes = findCancerTypes(context);
      const success = classifySuccess(`${context}\n${postText}`);
      const patientHandle = patientLabelFromLine(context, post.author);
      const sourceLink = `${rel}${post.source ? ` (${post.source})` : ""}`;
      const summary = buildPatientSummary({
        patientHandle,
        cancerTypes,
        protocols,
        success,
        snippet: sentenceClip(context, 260),
        sourceLink,
      });
      filePatientLabels.add(patientHandle);
      entitiesFound.add(patientHandle);
      patientMentionCount += 1;
      for (const cancerType of cancerTypes.length ? cancerTypes : ["Unknown"]) {
        addPatient(stores.patients, {
          patientHandle,
          cancerType,
          successStory: success,
          protocols,
          summary,
          sourceLink,
        });
      }
    }

    for (const name of extractPractitionerEntities(contactContext, post.author)) {
      filePractitionerNames.add(name);
      entitiesFound.add(name);
      addPractitioner(stores.practitioners, name, {
        sourceLink: `${rel}${post.source ? ` (${post.source})` : ""}`,
        snippet: `Posted in Jack Kruse forum. ${sentenceClip(contactContext, 220)}`,
        author: post.author,
      });
    }
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  for await (const rawLine of rl) {
    lineNo += 1;
    const line = rawLine;
    const stripped = stripMarkdown(line);

    const titleMatch = line.match(/^# Thread:\s+(.+)$/);
    if (titleMatch) threadTitle = stripMarkdown(titleMatch[1]);

    const headingMatch = line.match(/^###\s+(.+?)\s+(?:—|ג€”|-)\s+\d{4}/);
    if (headingMatch) {
      await finishPost();
      currentAuthor = stripMarkdown(headingMatch[1]);
      post = { author: currentAuthor, source: "", lines: [], startLine: lineNo };
      const authorEntity = cleanEntityName(currentAuthor);
      if (authorEntity && /^Dr\.?\s+/i.test(authorEntity)) {
        filePractitionerNames.add(authorEntity);
        entitiesFound.add(authorEntity);
        if (canonical) {
          addPractitioner(stores.practitioners, authorEntity, {
            sourceLink: rel,
            snippet: `Posted in Jack Kruse forum as author in thread "${threadTitle || "Unknown"}".`,
            author: currentAuthor,
          });
        }
      }
      continue;
    }

    const sourceMatch = line.match(/^\*\*Source:\*\*\s+<([^>]+)>/);
    if (sourceMatch) {
      currentSource = sourceMatch[1];
      if (post) post.source = currentSource;
    }

    if (post) post.lines.push(line);

    if (CANCER_CUE_RE.test(stripped)) cancerCueCount += 1;
    if (PRACTITIONER_CUE_RE.test(stripped)) practitionerCueCount += 1;

    if (PRACTITIONER_CUE_RE.test(stripped)) {
      const names = extractPractitionerEntities(stripped, currentAuthor);
      for (const name of names) {
        filePractitionerNames.add(name);
        entitiesFound.add(name);
        if (canonical) {
          addPractitioner(stores.practitioners, name, {
            sourceLink: `${rel}${currentSource ? ` (${currentSource})` : ""}`,
            snippet: stripped,
            author: currentAuthor,
          });
        }
      }
    }
  }
  await finishPost();

  const hasRelevantData =
    cancerCueCount > 0 || practitionerCueCount > 0 || filePractitionerNames.size > 0 || filePatientLabels.size > 0;
  const status = hasRelevantData ? "Processed" : "Skipped";
  const notes = hasRelevantData
    ? [
        canonical ? "Canonical thread file scanned for extraction." : "Derived bundle/category file scanned for log coverage; canonical thread files used for deduplicated workbook extraction.",
        `${cancerCueCount} cancer/protocol cue line(s), ${practitionerCueCount} practitioner cue line(s), ${filePractitionerNames.size} practitioner/lab entity name(s), ${patientMentionCount} patient mention(s).`,
      ].join(" ")
    : "No cancer, protocol, patient, practitioner, lab, or clinical contact cues found in first-pass line scan.";

  const entry = {
    filename: rel,
    status,
    entities_found: [...entitiesFound].sort((a, b) => a.localeCompare(b)),
    notes,
  };
  await streamLogEntry(entry);

  if (index % 250 === 0 || index === total) {
    await fsp.writeFile(
      STATE_PATH,
      JSON.stringify(
        {
          processed: index,
          total,
          current_file: rel,
          practitioners: stores.practitioners.size,
          patients: stores.patients.size,
          updated_at: new Date().toISOString(),
        },
        null,
        2
      )
    );
  }

  return entry;
}

async function reviewSkippedFiles(logEntries) {
  let reviewed = 0;
  let recovered = 0;
  for (const entry of logEntries) {
    if (entry.status !== "Skipped") continue;
    reviewed += 1;
    const fullPath = path.join(ROOT, entry.filename);
    let subtleHits = 0;
    const entities = new Set(entry.entities_found);
    const rl = readline.createInterface({
      input: fs.createReadStream(fullPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const stripped = stripMarkdown(line);
      if (SUBTLE_REVIEW_RE.test(stripped)) subtleHits += 1;
      for (const name of extractPractitionerEntities(stripped, "")) entities.add(name);
    }
    if (subtleHits > 0 || entities.size > 0) {
      entry.status = "Processed";
      entry.entities_found = [...entities].sort((a, b) => a.localeCompare(b));
      entry.notes = `Recovered during second-pass skipped-file review: ${subtleHits} subtle cancer/clinical cue line(s), ${entities.size} entity name(s).`;
      recovered += 1;
    } else {
      entry.notes = `${entry.notes} Second-pass skipped-file review completed; no subtle cancer/clinical cues found.`;
    }
  }
  return { reviewed, recovered };
}

function practitionerRows(stores) {
  return [...stores.practitioners.values()]
    .map((p) => ({
      Name: p.name,
      Role: p.role,
      "Alignment Evidence": p.alignmentEvidence.length
        ? p.alignmentEvidence.join(" | ")
        : "Review Needed: entity mentioned in forum context but alignment evidence is incomplete.",
      "Cancer Expertise": p.cancerExpertise,
      "Contact Details (emails/links)": p.contacts.size ? [...p.contacts].join("; ") : "Unknown",
      "Source Link": [...p.sourceLinks][0] || "Unknown",
      "Confidence Score": p.confidence,
      _evidenceCount: p.evidenceCount,
    }))
    .sort((a, b) => b["Confidence Score"] - a["Confidence Score"] || a.Name.localeCompare(b.Name));
}

function patientRows(stores) {
  return [...stores.patients.values()]
    .map((p) => ({
      "Patient Handle": p.patientHandle,
      "Cancer Type": p.cancerType || "Unknown",
      "Success Story (Yes/No/Partial)": p.successStory,
      "Protocols Used (e.g., DDW)": p.protocols.size ? [...p.protocols].join("; ") : "Unknown",
      "Detailed Summary (2-3 sentences)": p.summaries.join(" "),
      "Source Link": [...p.sourceLinks].join("; "),
      _evidenceCount: p.evidenceCount,
    }))
    .sort((a, b) => a["Patient Handle"].localeCompare(b["Patient Handle"]) || a["Cancer Type"].localeCompare(b["Cancer Type"]));
}

async function main() {
  await fsp.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  const files = await listMarkdownFiles(PROCESSED_DIR);
  const stores = {
    practitioners: new Map(),
    patients: new Map(),
  };
  const logEntries = [];

  const logStream = fs.createWriteStream(LOG_PATH, { encoding: "utf8" });
  logStream.write("[\n");
  let firstLogEntry = true;
  async function streamLogEntry(entry) {
    logEntries.push(entry);
    if (!firstLogEntry) logStream.write(",\n");
    firstLogEntry = false;
    logStream.write(JSON.stringify(entry, null, 2));
  }

  for (let i = 0; i < files.length; i += 1) {
    await scanFile(files[i], i + 1, files.length, stores, streamLogEntry);
  }
  logStream.write("\n]\n");
  await new Promise((resolve, reject) => {
    logStream.end((err) => (err ? reject(err) : resolve()));
  });

  const review = await reviewSkippedFiles(logEntries);
  await fsp.writeFile(LOG_PATH, JSON.stringify(logEntries, null, 2));

  const practitioners = practitionerRows(stores);
  const cancerPatients = patientRows(stores);

  await fsp.writeFile(
    OUTPUT_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        source_folder: toRel(PROCESSED_DIR),
        markdown_files_scanned: files.length,
        skipped_review: review,
        practitioners,
        cancerPatients,
      },
      null,
      2
    ),
    "utf8"
  );

  await fsp.writeFile(
    STATE_PATH,
    JSON.stringify(
      {
        completed: true,
        markdown_files_scanned: files.length,
        log_entries: logEntries.length,
        skipped_files_reviewed: review.reviewed,
        skipped_files_recovered: review.recovered,
        practitioner_rows: practitioners.length,
        cancer_patient_rows: cancerPatients.length,
        output: toRel(OUTPUT_PATH),
        processing_log: toRel(LOG_PATH),
        updated_at: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log(
    JSON.stringify(
      {
        markdown_files_scanned: files.length,
        log_entries: logEntries.length,
        skipped_files_reviewed: review.reviewed,
        skipped_files_recovered: review.recovered,
        practitioner_rows: practitioners.length,
        cancer_patient_rows: cancerPatients.length,
        output: toRel(OUTPUT_PATH),
        processing_log: toRel(LOG_PATH),
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
