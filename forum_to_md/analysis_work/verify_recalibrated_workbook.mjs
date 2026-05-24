import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const input = await FileBlob.load("D:/kruse/guy export/forum_to_md/clinical_patient_data.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);

const ranges = [
  "Cancer Doctors Clinics!A1:J9",
  "Other Practitioners!A1:I9",
  "Specific People!A1:I4",
  "Cancer Patients!A1:F6",
];

const samples = {};
for (const range of ranges) {
  const inspected = await workbook.inspect({
    kind: "table",
    range,
    include: "values,formulas",
    tableMaxRows: 10,
    tableMaxCols: 11,
  });
  samples[range] = inspected.ndjson.split("\n").slice(0, 1);
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 20 },
  summary: "formula error scan",
});

console.log(JSON.stringify({ samples, errors: errors.ndjson }, null, 2));
