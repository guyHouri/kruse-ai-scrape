import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const INPUT_PATH = path.join(ROOT, "analysis_work", "clinical_workbook_data.json");
const OUTPUT_PATH = path.join(ROOT, "clinical_patient_data.xlsx");
const CLEAN_DATA_PATH = path.join(ROOT, "analysis_work", "refined_clinical_workbook_data.json");
const PREVIEW_DIR = path.join(ROOT, "analysis_work", "previews");

const PRACTITIONER_HEADERS = [
  "Name",
  "Role (Doctor/Coach/Lab/Other)",
  "Cancer/Kruse Protocol Summary",
  "Alignment Evidence",
  "Cancer Expertise (Yes/No)",
  "Contact Details (emails/links)",
  "Source Link (specific file)",
  "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)",
  "Reasoning / Why This Score",
];

const PATIENT_HEADERS = [
  "Patient Handle",
  "Cancer Type",
  "Success Story (Yes/No/Partial)",
  "Protocols Used (e.g., DDW)",
  "Detailed Summary (2-3 sentences)",
  "Source Link",
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
    ) {
      output += char;
    }
  }
  return output;
}

function cleanField(value, max = 32000) {
  const cleaned = normalizeSpaces(xmlSafe(value)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (!cleaned) return "Unknown";
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 125).trim()} [field shortened to fit Excel cell limit; source details remain in processing_log.json and refined_clinical_workbook_data.json]`;
}

function splitList(value) {
  return normalizeSpaces(value)
    .split(/\s*;\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sourceFileOnly(source) {
  return normalizeSpaces(source).replace(/\s+\(https?:\/\/.*?\)\s*$/i, "");
}

function cleanPatientHandle(value) {
  const handle = normalizeSpaces(xmlSafe(value))
    .replace(/([a-z])Dr\..*$/g, "$1")
    .replace(/\s+said:?$/i, "")
    .trim();
  if (!handle || /^\[email redacted\]$/i.test(handle)) return "Redacted email-like forum handle(s)";
  return handle;
}

function protocolSet(value) {
  return splitList(value)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item && !/^Unknown$/i.test(item));
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
    if (successRank(raw["Success Story (Yes/No/Partial)"]) > successRank(existing.success)) {
      existing.success = raw["Success Story (Yes/No/Partial)"];
    }
    for (const protocol of protocolSet(raw["Protocols Used (e.g., DDW)"])) existing.protocols.add(protocol);
    for (const source of splitList(raw["Source Link"]).map(sourceFileOnly).filter(Boolean)) existing.sources.add(source);
    const summary = cleanField(raw["Detailed Summary (2-3 sentences)"], 1000);
    if (summary !== "Unknown" && existing.summaries.length < 5 && !existing.summaries.includes(summary)) {
      existing.summaries.push(summary);
    }
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

const curatedPractitioners = [
  {
    "Name": "Dr. John Gordon",
    "Role (Doctor/Coach/Lab/Other)": "Doctor",
    "Cancer/Kruse Protocol Summary":
      "Breast cancer patient Vervaina traveled to New Orleans/Metairie to see Gordon after learning from Jack's material. Gordon served as the cancer/surgical anchor: he evaluated the tumor as too large for immediate surgery, warned that survival odds were poor without chemotherapy, advised finding an oncologist, and was described by Jack as a trusted surgeon who could apply Jack's mitochondrial ideas. The surrounding Kruse protocol for that case included DDW/Somlyai, seafood/DHA, grounding, AM light/UV, CT, low tech/no light after sunset, topical iodine, methylene blue, and environmental redox work.",
    "Alignment Evidence":
      "Patient: 'I came to NOLA to see Dr John Gordon' for breast cancer; Gordon discussed chemo and mastectomy sequencing. Jack: 'I trust John huge' and later called him a serious mitochondrial/Black Swan surgeon whose hands could use Jack's ideas more powerfully.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "Unknown; Metairie/New Orleans area mentioned in source thread",
    "Source Link (specific file)":
      "processed_mds/threads/dr-john-gordons-newest-cancer-pt.21299.md (posts 240832, 240837, 240863)",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 10,
    "Reasoning / Why This Score":
      "10/10 because this is a named clinician directly involved with an active cancer patient inside the Kruse community, Jack explicitly vouches for him, and the case was being managed alongside Kruse-specific light, DDW, grounding, CT, seafood/DHA, and nnEMF avoidance work. Conventional oncology decisions were still referred to oncology.",
  },
  {
    "Name": "Kruse Longevity Center / Dr. Jack Kruse",
    "Role (Doctor/Coach/Lab/Other)": "Doctor",
    "Cancer/Kruse Protocol Summary":
      "Jack is the primary protocol source in the extracted forum data. Across pancreatic cancer, GBM/glioma, breast cancer, and cervical cancer discussions, his cancer-specific guidance centers on changing the entire environment: AM sun, UV/IR exposure, grounding, low nnEMF/low-tech living, seafood/DHA, cold/CT when tolerated, sleep/no light after sunset, tropical/caldera relocation for severe cases, DDW/Somlyai-style deuterium depletion, and circadian handling of conventional therapy when needed.",
    "Alignment Evidence":
      "For pancreatic cancer Jack wrote that the patient had to change everything and pointed to Gabor's book for that tumor type. For GBM he emphasized tropical/caldera sunlight context. For cervical cancer discussion he endorsed the redox-first stack of AM sunlight, grounding, DDW, PBM/sun, hypertonic saline, methylene blue, and drug questions to Makis.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "Forum source links only in extracted data",
    "Source Link (specific file)":
      "processed_mds/threads/my-dad-has-malignant-pancreatic-cancer-i´d-appreciate-suggestions-to-safe-his-life-if-not-too-late.27066.md; processed_mds/threads/glioblastoma-diagnosis-for-my-brother-seeking-help-and-hope.29254.md; processed_mds/threads/catherines-optimal-journal.30462.md",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 10,
    "Reasoning / Why This Score":
      "10/10 for Kruse-protocol relevance because he is the source of the environmental cancer protocol logic and directly comments on multiple cancer cases. This score reflects Kruse-specific protocol authority, not conventional oncology specialization.",
  },
  {
    "Name": "Block Center / Keith Block, MD",
    "Role (Doctor/Coach/Lab/Other)": "Doctor",
    "Cancer/Kruse Protocol Summary":
      "Jack identified Keith Block as the US cancer physician doing chrono-chemotherapy. In Vervaina's breast cancer thread, the patient began intake with Block Center after Jack's pointer, with the practical idea that if chemotherapy was unavoidable, it should be done with circadian timing and possibly with grounding/outdoor exposure around portable infusion.",
    "Alignment Evidence":
      "Jack: Keith Block has been doing chrono-chemotherapy for years and is the cancer MD in the US for that approach. Patient: called Block Center and started intake after Jack's recommendation.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "Unknown in extracted source; Block Center named",
    "Source Link (specific file)": "processed_mds/threads/dr-john-gordons-newest-cancer-pt.21299.md (posts 240864, 240982)",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 9,
    "Reasoning / Why This Score":
      "9/10 because it is a named cancer clinic/MD with a circadian chemotherapy angle explicitly recommended by Jack, but the source does not show Block Center itself using the full Kruse stack of DDW, nnEMF mitigation, sunrise/UV, grounding, and CT.",
  },
  {
    "Name": "Dr. Makis",
    "Role (Doctor/Coach/Lab/Other)": "Doctor",
    "Cancer/Kruse Protocol Summary":
      "Catherine paid for a three-month Dr. Makis service and later followed his cervical cancer protocol, described in the thread as ivermectin plus mebendazole and many supplements. Jack repeatedly deferred drug-protocol questions to Makis and called him the better expert for ivermectin dosing, while Catherine layered Makis's protocol onto Jack's environmental stack of sun, DDW, grounding, seafood, methylene blue, PBM/sun, sweating, and low-tech living.",
    "Alignment Evidence":
      "Patient: paid for Dr. Makis service, received his protocol, and later wrote she was following Makis's cervical cancer protocol with ivermectin and mebendazole. Jack: 'Talk to Makis not me' for that drug-protocol decision.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "Unknown in extracted source; paid service mentioned",
    "Source Link (specific file)": "processed_mds/threads/catherines-optimal-journal.30462.md (posts 349418 and related Catherine updates)",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 8,
    "Reasoning / Why This Score":
      "8/10 because the source shows paid cancer-protocol involvement and Jack defers drug questions to him, but it does not show Makis himself treating with the full Kruse environmental protocol; the Kruse layer appears to come from Jack/Catherine.",
  },
  {
    "Name": "Dr. Zsofia Clemens / Paleomedicina",
    "Role (Doctor/Coach/Lab/Other)": "Doctor",
    "Cancer/Kruse Protocol Summary":
      "Forum members repeatedly point cancer patients, especially GBM/glioma and pancreatic cancer discussions, toward Zsofia Clemens/Paleomedicina for strict Paleolithic Ketogenic Diet work. The extracted GBM thread says she deals with GBMs through strict PKD and links Paleomedicina resources, while other posters note that the approach is strong on diet but may not contain the full Kruse light/EMF story.",
    "Alignment Evidence":
      "GBM thread: Clemens deals with GBMs through strict PKD. Pancreatic cancer thread: a member says somebody really good for cancer is Zsofia Clemens in Romania and provides the Paleomedicina URL.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "https://www.paleomedicina.com/en/dr-zsofia-clemens",
    "Source Link (specific file)":
      "processed_mds/threads/glioblastoma-diagnosis-for-my-brother-seeking-help-and-hope.29254.md; processed_mds/threads/my-dad-has-malignant-pancreatic-cancer-i´d-appreciate-suggestions-to-safe-his-life-if-not-too-late.27066.md",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 8,
    "Reasoning / Why This Score":
      "8/10 because this is a clinician/clinic repeatedly referred for cancer cases, especially brain cancer/GBM diet therapy, but the evidence is ketogenic/PKD-centered rather than clearly Kruse-protocol-centered.",
  },
  {
    "Name": "Gabor Somlyai / DDW cancer framework",
    "Role (Doctor/Coach/Lab/Other)": "Other",
    "Cancer/Kruse Protocol Summary":
      "Somlyai's DDW work is repeatedly treated as the deuterium depletion backbone for cancer cases. Jack and members point pancreatic cancer, breast cancer, and DDW users to his book and framework; the practical protocol discussions include DDW-25/Qlarivia, longer duration use, ppm titration, and using DDW alongside conventional cancer therapy.",
    "Alignment Evidence":
      "Jack told the breast cancer patient to get Somlyai's book on deuterium ASAP. In the pancreatic cancer thread Jack said Gabor's book has a lot on that tumor type; members discuss 85-105 ppm starts, Qlarivia/DDW-25, and long-term use.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "Book/framework referenced; direct contact unknown in extracted data",
    "Source Link (specific file)":
      "processed_mds/threads/dr-john-gordons-newest-cancer-pt.21299.md; processed_mds/threads/my-dad-has-malignant-pancreatic-cancer-i´d-appreciate-suggestions-to-safe-his-life-if-not-too-late.27066.md; processed_mds/threads/aussies-deuterium-depleted-water.20955.md",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 8,
    "Reasoning / Why This Score":
      "8/10 because the DDW cancer evidence is central and repeatedly used in Kruse cancer cases, but the row is a research/protocol source rather than a clearly available treating clinician/clinic in the forum data.",
  },
  {
    "Name": "Dr. Laszlo Boros",
    "Role (Doctor/Coach/Lab/Other)": "Other",
    "Cancer/Kruse Protocol Summary":
      "Boros appears as a deuterium/metabolic-cancer expert rather than a treating clinician. The strongest lead says he has done notable work on renal cancers with DDW and might be contacted at UCLA; another thread explicitly distinguishes him as a biochemist/lab researcher rather than a clinician.",
    "Alignment Evidence":
      "Cancer journey thread: Dr. Laszlo Boros has done amazing work on renal cancers with DDW. DDW thread: Boros is a biochemist and not a clinician.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "UCLA mentioned; direct contact unknown in extracted data",
    "Source Link (specific file)": "processed_mds/threads/cancer-journey.21492.md; processed_mds/threads/50-ppm-ddw.23932.md",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 7,
    "Reasoning / Why This Score":
      "7/10 because he is strongly aligned with DDW/deuterium cancer reasoning, but the source itself warns he is not a clinician.",
  },
  {
    "Name": "Dr. Thomas Seyfried",
    "Role (Doctor/Coach/Lab/Other)": "Other",
    "Cancer/Kruse Protocol Summary":
      "Seyfried is cited for cancer as a mitochondrial/metabolic disease and for ketogenic/fasting-style metabolic therapy logic. This aligns with part of Kruse's mitochondrial cancer frame, but the extracted evidence is a book/research recommendation rather than a Kruse-protocol treating clinic.",
    "Alignment Evidence":
      "Forum thread quotes reviewers describing Seyfried's cancer work as metabolic/mitochondrial, with strategies including lowering glucose, elevating ketones, fasting, calorie-restricted ketogenic diets, and metabolic drugs.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "Book/research referenced; direct contact unknown in extracted data",
    "Source Link (specific file)": "processed_mds/threads/awesome-report-on-ketogenic-diet-cancer.5188.md",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 6,
    "Reasoning / Why This Score":
      "6/10 because the cancer expertise is strong, but the source does not show him as a clinician treating forum patients or using Kruse light/DDW/EMF protocols.",
  },
  {
    "Name": "Gerson Clinic / Gerson Therapy",
    "Role (Doctor/Coach/Lab/Other)": "Other",
    "Cancer/Kruse Protocol Summary":
      "One forum member with brain tumor/surgery history went to Mexico for Gerson Therapy, stayed on the protocol for two years, and later reconnected with the Gerson clinic after a seizure because they had experienced 'everything I hoped' under that care. This is a cancer-adjacent clinic lead, but the source does not connect it to Kruse-specific DDW, sunrise/EMF, or grounding protocols.",
    "Alignment Evidence":
      "Patient journal: went to Mexico for three weeks learning Gerson Therapy and stayed on the protocol two years; later reconnected with the Gerson clinic after a seizure.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "Unknown in extracted source; Mexico clinic mentioned",
    "Source Link (specific file)": "processed_mds/threads/charmanes-journal.23610.md",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 5,
    "Reasoning / Why This Score":
      "5/10 because it is a cancer-care clinic/protocol lead from a patient story, but it is not shown as Kruse-aligned beyond the patient later joining the Kruse forum.",
  },
  {
    "Name": "Dr. David Brownstein",
    "Role (Doctor/Coach/Lab/Other)": "Doctor",
    "Cancer/Kruse Protocol Summary":
      "Brownstein is cited for iodine-centered cancer anecdotes, including advanced uterine/vaginal cancer and breast-cancer-related iodine discussion. This is potentially relevant to the iodine portion of some forum cancer protocols but not enough to establish a Kruse-aligned cancer clinic lead.",
    "Alignment Evidence":
      "Forum thread references Brownstein's iodine protocol and cancer anecdotes, including advanced uterine/vaginal cancer and breast cancer discussion.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "Unknown in extracted source",
    "Source Link (specific file)": "processed_mds/threads/antibody-wakes-up-t-cells-to-make-cancer-vanish.7241.md",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 5,
    "Reasoning / Why This Score":
      "5/10 because there is cancer-related iodine evidence, but no clear forum evidence that he treats cancer patients with Kruse protocols.",
  },
  {
    "Name": "Dr. Jorge Flechas",
    "Role (Doctor/Coach/Lab/Other)": "Doctor",
    "Cancer/Kruse Protocol Summary":
      "Flechas appears in extracted files through iodine deficiency and cancer resources, including total body iodine sufficiency. This may support iodine testing/sufficiency considerations but is not a direct cancer-treatment-with-Kruse-protocol lead.",
    "Alignment Evidence": "Thread lists Jorge Flechas iodine deficiency and cancer materials and iodine sufficiency materials.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "Unknown in extracted source",
    "Source Link (specific file)": "processed_mds/threads/beautiful-man-and-nature-in-tune-and-producing-unrefined-sea-salt.20949.md",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 4,
    "Reasoning / Why This Score":
      "4/10 because cancer is mentioned in an iodine-resource context, but the extraction does not show direct patient treatment or Kruse protocol use.",
  },
  {
    "Name": "Dr. Mark Sircus",
    "Role (Doctor/Coach/Lab/Other)": "Other",
    "Cancer/Kruse Protocol Summary":
      "Sircus appears as an alternative cancer-resource lead around bicarbonate/hydrogen/oxygen ideas in forum discussion. The extracted evidence is too indirect to treat as a primary cancer clinician lead.",
    "Alignment Evidence": "Forum cancer discussions mention Sircus-style bicarbonate/alternative cancer material.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "Unknown in extracted source",
    "Source Link (specific file)": "processed_mds/threads/dr-john-gordons-newest-cancer-pt.21299.md",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 3,
    "Reasoning / Why This Score":
      "3/10 because this is a weak alternative-resource mention and not a verified Kruse-aligned treating doctor or clinic in the source corpus.",
  },
  {
    "Name": "Dr. Tullio Simoncini",
    "Role (Doctor/Coach/Lab/Other)": "Doctor",
    "Cancer/Kruse Protocol Summary":
      "Simoncini is referenced around sodium bicarbonate/injection-style cancer claims. The forum evidence is not enough to classify him as a Kruse-aligned clinician lead.",
    "Alignment Evidence": "Forum files mention Simoncini in relation to sodium bicarbonate cancer approaches.",
    "Cancer Expertise (Yes/No)": "Yes",
    "Contact Details (emails/links)": "Unknown in extracted source",
    "Source Link (specific file)": "processed_mds/threads/jack-for-calcium-help-its-elaine.11935.md",
    "Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)": 3,
    "Reasoning / Why This Score":
      "3/10 because this is a cancer-method mention only, with no source evidence of Kruse protocol use or forum patient management.",
  },
];

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
  sheet.getRange(`A1:${lastColumn}1`).format.rowHeight = 52;
  for (let i = 0; i < widths.length; i += 1) {
    sheet.getRange(`${columnLetter(i)}:${columnLetter(i)}`).format.columnWidth = widths[i];
  }
  sheet.tables.add(`A1:${lastColumn}${lastRow}`, true, tableName);
}

async function main() {
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  const input = JSON.parse(await fs.readFile(INPUT_PATH, "utf8"));
  const patients = mergePatients(input.cancerPatients);
  const practitioners = curatedPractitioners.map((row) => {
    const cleanRow = {};
    for (const header of PRACTITIONER_HEADERS) cleanRow[header] = cleanField(row[header], 32000);
    cleanRow["Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)"] =
      row["Confidence Score (1-10; 10 = known cancer clinician/clinic using Kruse-aligned protocols)"];
    return cleanRow;
  });

  await fs.writeFile(
    CLEAN_DATA_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        source_workbook_data: INPUT_PATH,
        patient_rule: "One row per cleaned forum handle; [email redacted] source handles are collapsed because the original usernames are absent from processed markdown.",
        practitioner_rule:
          "Curated evidence-gated shortlist. A 10/10 requires direct cancer-patient or clinic involvement plus explicit Kruse-aligned protocol evidence (light/EMF/DDW/grounding/circadian/etc.) in the forum source.",
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
  writeSheet(practitionersSheet, PRACTITIONER_HEADERS, practitioners, "PractitionersTable", [26, 18, 72, 72, 18, 42, 70, 18, 72]);
  practitionersSheet.getRange(`A2:I${practitioners.length + 1}`).format.wrapText = true;
  practitionersSheet.getRange(`A2:I${practitioners.length + 1}`).format.rowHeight = 118;
  writeSheet(patientsSheet, PATIENT_HEADERS, patients, "CancerPatientsTable", [28, 30, 24, 54, 110, 90]);

  const previewWorkbook = Workbook.create();
  const practitionersPreviewSheet = previewWorkbook.worksheets.add("Practitioners");
  const patientsPreviewSheet = previewWorkbook.worksheets.add("Cancer Patients");
  writeSheet(practitionersPreviewSheet, PRACTITIONER_HEADERS, practitioners, "PractitionersPreviewTable", [26, 18, 72, 72, 18, 42, 70, 18, 72]);
  practitionersPreviewSheet.getRange(`A2:I${practitioners.length + 1}`).format.wrapText = true;
  practitionersPreviewSheet.getRange(`A2:I${practitioners.length + 1}`).format.rowHeight = 118;
  writeSheet(patientsPreviewSheet, PATIENT_HEADERS, patients.slice(0, 45), "CancerPatientsPreviewTable", [28, 30, 24, 54, 110, 90]);

  const practitionerPreview = await previewWorkbook.render({
    sheetName: "Practitioners",
    autoCrop: "all",
    scale: 0.55,
    format: "png",
  });
  await fs.writeFile(path.join(PREVIEW_DIR, "refined_practitioners.png"), new Uint8Array(await practitionerPreview.arrayBuffer()));

  const patientPreview = await previewWorkbook.render({
    sheetName: "Cancer Patients",
    autoCrop: "all",
    scale: 0.55,
    format: "png",
  });
  await fs.writeFile(path.join(PREVIEW_DIR, "refined_cancer_patients.png"), new Uint8Array(await patientPreview.arrayBuffer()));

  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(OUTPUT_PATH);

  console.log(
    JSON.stringify(
      {
        output: OUTPUT_PATH,
        clean_data: CLEAN_DATA_PATH,
        practitioner_rows: practitioners.length,
        cancer_patient_rows: patients.length,
        redacted_patient_rows: patients.filter((row) => /^Redacted email-like/i.test(row["Patient Handle"])).length,
        previews: [
          path.join(PREVIEW_DIR, "refined_practitioners.png"),
          path.join(PREVIEW_DIR, "refined_cancer_patients.png"),
        ],
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
