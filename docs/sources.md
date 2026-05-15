# 🧬 Project: Kruse AI - Knowledge Source Index

## 🛠️ Data Sources Hierarchy & Complexity Mapping

| **Data Source**                  | **Priority (Weight)** | **Difficulty (ETL)** | **Format**          |
| -------------------------------- | --------------------- | -------------------- | ------------------- |
| **Q&A & PowWows (2012-2026)**    | 10/10                 | High                 | MP3 / Transcription |
| **Forum Comments & Discussions** | 9/10                  | Medium-High          | Web / HTML Scraping |
| **X (Twitter) Posts & Threads**  | 7/10                  | Medium               | JSON / API          |
| **Podcast Transcripts**          | 6/10                  | Medium               | Audio / CSV         |
| **Blog Posts (Science Backlog)** | 4/10                  | Low-Medium           | Text / Markdown     |
| **LinkedIn & FB Articles**       | 3/10                  | Low                  | Static Links        |

---

## 🏗️ Phase 1: High-ROI Audio Sources (Dynamic Knowledge)

### 🎙️ PowWows & Monthly Q&A (2012 - 2026)

- **Description:** Monthly member calls and post-lecture sessions.
- **Technical Requirement:** Massive-scale STT (Speech-to-Text). Requires Whisper-based processing with speaker diarization.
- **Source:** [Terabox Repository](https://www.terabox.app/sharing/link?surl=XhIbTa7b5bSZeRif9Qt-VA)

### 🎧 Podcast Aggregations

- **Description:** External interviews and guest appearances.
- **Index 1:** [Primary Podcast Spreadsheet](https://docs.google.com/spreadsheets/d/1vA-OPXzFk99DS1NwvptMevxoWDTgrO2fJKw5lv3lzSw/edit?gid=0#gid=0)
- **Index 2:** [Secondary Podcast Spreadsheet](https://docs.google.com/spreadsheets/d/1q6_n-pYZ122qM8o7RCWdgJEzXJvxYPKsUUlXt-JPG2w/edit?gid=1572874715#gid=1572874715)

---

## 💬 Phase 2: Unstructured Community Data

### 🏛️ Forum Interactions

- **Description:** Direct engagement and specific protocols found in forum threads.
- **Technical Requirement:** Web crawling focused on comment sections. Need to filter for user "JackKruse" to prioritize signal over noise.

### 📱 Short-Form Thought Leadership (X / Twitter)

- **Description:** Real-time updates and condensed scientific threads.
- **Source:** [Thread Reader Archive](https://threadreaderapp.com/user/DrJackKruse)

---

## 📄 Phase 3: Static & Legacy Content

### 📑 Science Blogs (Kruse/Patreon)

- **Description:** Theoretical foundation. High scientific density but lower practical ROI for daily RAG queries.
- **Status:** Requires extraction from legacy web structures.

### 💼 Professional Platforms (LinkedIn / Facebook)

- **Description:** Supplementary articles and cross-posted content.
- **Index:** [LinkedIn Post Archive](https://docs.google.com/spreadsheets/d/1FOublpCg0g5xAY8lvRnP4Jpcz4mfKd0Lcab5zkpTQeM/edit?gid=1970126119#gid=1970126119)

---

## 🚀 ETL Strategy Notes

- **Chunking Strategy:** Semantic chunking is recommended due to the non-linear nature of the Q&A sessions.
- **Metadata Tagging:** Every node must be tagged with `Source_Type` and `Year` to account for protocol evolution.
