import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const ROOT = path.resolve("..");
const INPUT_PATH = path.join(ROOT, "analysis_work", "clinical_extraction.json");
const OUTPUT_PATH = path.join(ROOT, "clinical_patient_data.xlsx");
const PREVIEW_DIR = path.join(ROOT, "analysis_work", "previews");
const CLEAN_DATA_PATH = path.join(ROOT, "analysis_work", "clinical_workbook_data.json");

const PRACTITIONER_HEADERS = [
  "Name",
  "Role (Doctor/Coach/Lab/Other)",
  "Alignment Evidence",
  "Cancer Expertise (Yes/No)",
  "Contact Details (emails/links)",
  "Source Link (specific file)",
  "Confidence Score (1-10; 10 = clinical cancer experience, 1 = online coach)",
];

const PATIENT_HEADERS = [
  "Patient Handle",
  "Cancer Type",
  "Success Story (Yes/No/Partial)",
  "Protocols Used (e.g., DDW)",
  "Detailed Summary (2-3 sentences)",
  "Source Link",
];

const ROLE_RANK = { Doctor: 4, Lab: 3, Coach: 2, Other: 1 };

function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function xmlSafe(value) {
  let output = "";
  for (const char of String(value || "")) {
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
  const cleaned = normalizeSpaces(xmlSafe(value))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\s+\|\s+/g, " | ");
  if (cleaned.length <= max) return cleaned || "Unknown";
  return `${cleaned.slice(0, max - 110).trim()} [field shortened to fit Excel cell limit; full evidence remains in processing_log.json]`;
}

function splitSourceLinks(value) {
  return normalizeSpaces(value)
    .split(/\s*;\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function canonicalNameKey(name) {
  return normalizeSpaces(name)
    .toLowerCase()
    .replace(/\bdr\.?\s+/g, "")
    .replace(/\bdoctor\s+/g, "")
    .replace(/\b(?:m\.?d\.?|d\.?o\.?|n\.?d\.?|d\.?c\.?|ph\.?d\.?|o\.?d\.?)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleCaseRole(role) {
  return ["Doctor", "Coach", "Lab", "Other"].includes(role) ? role : "Other";
}

function cleanPractitionerName(raw) {
  let name = normalizeSpaces(xmlSafe(raw))
    .replace(/\s+/g, " ")
    .replace(/^[^A-Z0-9]*(?=Dr\.?\s+[A-Z])/i, "")
    .replace(/^.*?\b(Dr\.?\s+[A-Z].*)$/i, "$1")
    .replace(/^(?:At the|Called the|As for|Apparently the|Apparently|Author|Board of the|Collaborating Center of the|Director of the|Source|From)\s+/i, "")
    .replace(/^Ph\.?D\.?\s+/i, "")
    .replace(/\bI(?:'|’)ve\b.*$/i, "")
    .replace(/\bI(?:'|’)m\b.*$/i, "")
    .replace(/\bThey\b.*$/i, "")
    .replace(/\bThis\b.*$/i, "")
    .replace(/\bThat\b.*$/i, "")
    .replace(/\bFirst\b.*$/i, "")
    .replace(/\bOn\b.*$/i, "")
    .replace(/\bwas\b.*$/i, "")
    .replace(/\s+of the Pasteur Institute.*$/i, "")
    .replace(/\s+of Pasteur Institute.*$/i, "")
    .replace(/\bDr\s+/i, "Dr. ")
    .replace(/\bM\.?D\.?\b/i, "M.D.")
    .replace(/\bD\.?O\.?\b/i, "D.O.")
    .replace(/\bN\.?D\.?\b/i, "N.D.")
    .replace(/\bD\.?C\.?\b/i, "D.C.")
    .replace(/\bPh\.?D\.?\b/i, "Ph.D.")
    .replace(/[,:;()[\]{}]+$/g, "")
    .trim();

  if (/^AIDS\.\s+Dr\./i.test(name)) name = name.replace(/^AIDS\.\s+/i, "");
  if (/^Kruse Longevity Center$/i.test(name)) return "Kruse Longevity Center";
  if (/^Hydro Health$/i.test(name)) return "Hydro Health";
  return name;
}

function isInstitutionLike(name) {
  return /\b(?:Labs?|Laborator(?:y|ies)|Clinic|Clinics|Center|Centre|Institute|Hospital|Diagnostics|Wellness|Health|Medical|Pharmacy|University|College|School|Pathology)\b/i.test(name);
}

function isLabLike(name) {
  return /\b(?:Labs?|Laborator(?:y|ies)|Diagnostics|Pathology|Quest Diagnostics|LabCorp|Genova|DUTCH|SpectraCell|Cyrex|Vibrant|ZRT|Doctors Data|Doctor's Data|23andMe|Promethease)\b/i.test(name);
}

function isPersonLike(name) {
  const withoutTitle = name.replace(/^Dr\.?\s+/i, "").replace(/\b(?:M\.D\.|D\.O\.|N\.D\.|D\.C\.|Ph\.D\.|O\.D\.)\b/gi, "").trim();
  if (/^(?:[A-Z][A-Za-z'’.-]+|[A-Z]\.)(?:\s+(?:[A-Z][A-Za-z'’.-]+|[A-Z]\.)){1,4}$/.test(withoutTitle)) return true;
  if (/^Dr\.?\s+[A-Z][A-Za-z'’.-]+$/.test(name)) return true;
  return false;
}

function badPractitionerName(name) {
  if (!name || name.length < 3 || name.length > 90) return true;
  if (/[?]|\b(?:about|above|after|again|also|another|because|before|below|between|could|doesn|during|getting|going|have|help|into|make|need|other|said|should|that|their|there|these|they|this|those|through|under|were|what|when|where|which|while|with|would|your)\b/i.test(name)) return true;
  if (/^(?:Alternative Health|British Medical|Cancer Therapy|Cold Therapy|Adjuvant Endocrine Therapy|Decentrlaized Medical|Deuterium Depletion for Optimal Health|Edition\.? Medical|FACP Medical|Mental Health|Manual Therapy|Oral Oxygen Therapy|EWOT for Oxygen Therapy|Biomarkers of Diet for Health|Improve Your Health The Center|Is the Present Therapy|FOR ALL YOU|Alpine|Bodybuilders|Coming On Board|Children Health)$/i.test(name)) return true;
  if (/\b(?:Journal|DOKUMEN\.PUB|Edition|Therapy)$/i.test(name) && !/\b(?:Center|Centre|Clinic|Hospital|Institute)\b/i.test(name)) return true;
  if (/^(?:American Veterinary Medical|American National Standards Institute|British Medical|Collaborating Center of the World Health)$/i.test(name)) return true;
  return false;
}

function inferCleanRole(name, rawRole, evidence) {
  if (isLabLike(name)) return "Lab";
  if (/^Dr\.?\s+/i.test(name) || /\b(?:M\.D\.|D\.O\.|N\.D\.|D\.C\.|O\.D\.)\b/i.test(name)) return "Doctor";
  if (rawRole === "Coach" || /\bcoach(?:ing)?\b/i.test(evidence)) return "Coach";
  if (isInstitutionLike(name)) return "Other";
  if (rawRole === "Doctor" && isPersonLike(name)) return "Doctor";
  return titleCaseRole(rawRole);
}

function recomputeConfidence(row, role) {
  const cancer = row["Cancer Expertise"] === "Yes";
  const evidence = row["Alignment Evidence"] || "";
  if (/\boncolog(?:ist|y)|cancer\s+(?:doctor|clinic|center|centre)|treat(?:s|ed|ing)?\s+cancer/i.test(evidence)) return 10;
  if (role === "Doctor" && cancer) return 9;
  if (role === "Doctor") return 6;
  if (role === "Lab" && cancer) return 7;
  if (role === "Lab") return 5;
  if (role === "Coach") return cancer ? 3 : 1;
  return cancer ? 4 : 2;
}

function cleanPractitioners(rows) {
  const merged = new Map();
  for (const raw of rows) {
    const name = cleanPractitionerName(raw.Name);
    if (badPractitionerName(name)) continue;
    const rawRole = titleCaseRole(raw.Role);
    const evidence = cleanField(raw["Alignment Evidence"], 2600);
    if (!isPersonLike(name) && !isInstitutionLike(name) && !/^Dr\.?\s+/i.test(name)) continue;

    const role = inferCleanRole(name, rawRole, evidence);
    const key = canonicalNameKey(name);
    if (!key) continue;
    const existing =
      merged.get(key) ||
      {
        Name: name,
        Role: role,
        Evidence: [],
        CancerExpertise: "No",
        Contacts: new Set(),
        Sources: new Set(),
        Confidence: 1,
      };

    if (ROLE_RANK[role] > ROLE_RANK[existing.Role]) existing.Role = role;
    if (raw["Cancer Expertise"] === "Yes") existing.CancerExpertise = "Yes";
    for (const contact of splitSourceLinks(raw["Contact Details (emails/links)"]).filter((x) => x !== "Unknown")) existing.Contacts.add(contact);
    for (const source of splitSourceLinks(raw["Source Link"])) existing.Sources.add(source);
    if (existing.Evidence.length < 4 && evidence && !existing.Evidence.includes(evidence)) existing.Evidence.push(evidence);
    existing.Confidence = Math.max(existing.Confidence, recomputeConfidence(raw, role), Number(raw["Confidence Score"]) || 1);
    merged.set(key, existing);
  }

  return [...merged.values()]
    .map((row) => {
      const confidence = Math.min(10, recomputeConfidence(
        {
          "Cancer Expertise": row.CancerExpertise,
          "Alignment Evidence": row.Evidence.join(" | "),
        },
        row.Role
      ));
      return {
        Name: row.Name,
        "Role (Doctor/Coach/Lab/Other)": row.Role,
        "Alignment Evidence": cleanField(row.Evidence.join(" | "), 3000),
        "Cancer Expertise (Yes/No)": row.CancerExpertise,
        "Contact Details (emails/links)": row.Contacts.size ? cleanField([...row.Contacts].join("; "), 3000) : "Unknown",
        "Source Link (specific file)": cleanField([...row.Sources][0] || "Unknown", 3000),
        "Confidence Score (1-10; 10 = clinical cancer experience, 1 = online coach)": confidence,
      };
    })
    .sort((a, b) => {
      return (
        b["Confidence Score (1-10; 10 = clinical cancer experience, 1 = online coach)"] -
          a["Confidence Score (1-10; 10 = clinical cancer experience, 1 = online coach)"] ||
        a.Name.localeCompare(b.Name)
      );
    });
}

function cleanPatientHandle(value) {
  return normalizeSpaces(xmlSafe(value))
    .replace(/([a-z])Dr\..*$/g, "$1")
    .replace(/\s+said:?$/i, "")
    .trim() || "Unknown";
}

function compactSummary(value) {
  const text = cleanField(value, 1800)
    .replace(/\s*Evidence from\s+/g, " Evidence from ")
    .replace(/\s{2,}/g, " ");
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return cleanField(sentences.slice(0, 3).join(" "), 1200);
}

function successRank(value) {
  return { No: 1, Partial: 2, Yes: 3 }[value] || 1;
}

function cleanPatients(rows) {
  const merged = new Map();
  for (const raw of rows) {
    const handle = cleanPatientHandle(raw["Patient Handle"]);
    const cancerType = normalizeSpaces(raw["Cancer Type"]) || "Unknown";
    const key = `${handle.toLowerCase()}|${cancerType.toLowerCase()}`;
    const existing =
      merged.get(key) ||
      {
        handle,
        cancerType,
        success: "No",
        protocols: new Set(),
        summaries: [],
        sources: new Set(),
      };
    if (successRank(raw["Success Story (Yes/No/Partial)"]) > successRank(existing.success)) existing.success = raw["Success Story (Yes/No/Partial)"];
    for (const protocol of normalizeSpaces(raw["Protocols Used (e.g., DDW)"]).split(/\s*;\s*/).filter(Boolean)) {
      if (protocol !== "Unknown") existing.protocols.add(protocol);
    }
    for (const source of splitSourceLinks(raw["Source Link"])) existing.sources.add(source);
    const summary = compactSummary(raw["Detailed Summary (2-3 sentences)"]);
    if (existing.summaries.length < 3 && !existing.summaries.includes(summary)) existing.summaries.push(summary);
    merged.set(key, existing);
  }

  return [...merged.values()]
    .map((row) => ({
      "Patient Handle": row.handle,
      "Cancer Type": row.cancerType,
      "Success Story (Yes/No/Partial)": row.success,
      "Protocols Used (e.g., DDW)": row.protocols.size ? cleanField([...row.protocols].join("; "), 3000) : "Unknown",
      "Detailed Summary (2-3 sentences)": cleanField(row.summaries.join(" "), 1800),
      "Source Link": cleanField([...row.sources].join("; "), 32000),
    }))
    .sort((a, b) => a["Patient Handle"].localeCompare(b["Patient Handle"]) || a["Cancer Type"].localeCompare(b["Cancer Type"]));
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
  sheet.getRange(`A1:${lastColumn}1`).format.rowHeight = 42;
  for (let i = 0; i < widths.length; i += 1) {
    sheet.getRange(`${columnLetter(i)}:${columnLetter(i)}`).format.columnWidth = widths[i];
  }
  sheet.tables.add(`A1:${lastColumn}${lastRow}`, true, tableName);
}

async function main() {
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  const input = JSON.parse(await fs.readFile(INPUT_PATH, "utf8"));
  const practitioners = cleanPractitioners(input.practitioners);
  const cancerPatients = cleanPatients(input.cancerPatients);

  await fs.writeFile(
    CLEAN_DATA_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        markdown_files_scanned: input.markdown_files_scanned,
        skipped_review: input.skipped_review,
        practitioner_rows: practitioners.length,
        cancer_patient_rows: cancerPatients.length,
        practitioners,
        cancerPatients,
      },
      null,
      2
    )
  );

  const workbook = Workbook.create();
  const practitionersSheet = workbook.worksheets.add("Practitioners");
  const patientsSheet = workbook.worksheets.add("Cancer Patients");
  writeSheet(practitionersSheet, PRACTITIONER_HEADERS, practitioners, "PractitionersTable", [24, 18, 82, 18, 38, 64, 18]);
  writeSheet(patientsSheet, PATIENT_HEADERS, cancerPatients, "CancerPatientsTable", [24, 24, 24, 44, 96, 72]);

  const previewWorkbook = Workbook.create();
  const practitionersPreviewSheet = previewWorkbook.worksheets.add("Practitioners");
  const patientsPreviewSheet = previewWorkbook.worksheets.add("Cancer Patients");
  writeSheet(practitionersPreviewSheet, PRACTITIONER_HEADERS, practitioners.slice(0, 40), "PractitionersPreviewTable", [24, 18, 82, 18, 38, 64, 18]);
  writeSheet(patientsPreviewSheet, PATIENT_HEADERS, cancerPatients.slice(0, 40), "CancerPatientsPreviewTable", [24, 24, 24, 44, 96, 72]);

  const practitionersPreview = await previewWorkbook.render({
    sheetName: "Practitioners",
    autoCrop: "all",
    scale: 0.55,
    format: "png",
  });
  await fs.writeFile(path.join(PREVIEW_DIR, "practitioners.png"), new Uint8Array(await practitionersPreview.arrayBuffer()));

  const patientsPreview = await previewWorkbook.render({
    sheetName: "Cancer Patients",
    autoCrop: "all",
    scale: 0.55,
    format: "png",
  });
  await fs.writeFile(path.join(PREVIEW_DIR, "cancer_patients.png"), new Uint8Array(await patientsPreview.arrayBuffer()));

  const xlsx = await SpreadsheetFile.exportXlsx(workbook);
  await xlsx.save(OUTPUT_PATH);

  console.log(
    JSON.stringify(
      {
        output: OUTPUT_PATH,
        clean_data: CLEAN_DATA_PATH,
        practitioner_rows: practitioners.length,
        cancer_patient_rows: cancerPatients.length,
        previews: [
          path.join(PREVIEW_DIR, "practitioners.png"),
          path.join(PREVIEW_DIR, "cancer_patients.png"),
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
