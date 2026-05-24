import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const input = await FileBlob.load("D:/kruse/guy export/forum_to_md/clinical_patient_data.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);

const practitioners = await workbook.inspect({
  kind: "table",
  range: "Practitioners!A1:I14",
  include: "values,formulas",
  tableMaxRows: 14,
  tableMaxCols: 9,
});

const patients = await workbook.inspect({
  kind: "table",
  range: "Cancer Patients!A1:F8",
  include: "values,formulas",
  tableMaxRows: 8,
  tableMaxCols: 6,
});

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 20 },
  summary: "final formula error scan",
});

console.log(JSON.stringify({
  practitioners_sample: practitioners.ndjson.split("\n").slice(0, 5),
  patients_sample: patients.ndjson.split("\n").slice(0, 5),
  formula_errors: errors.ndjson,
}, null, 2));
