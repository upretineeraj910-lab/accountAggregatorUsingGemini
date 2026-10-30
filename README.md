# Statement Check — LoanSaarthi Internal Bank Statement Underwriting Tool

Internal tool for LoanSaarthi loan DSA employees to upload and analyze client bank statements (3–6 months) for credit underwriting, obligations verification, salary detection, and risk signal forensics.

---

## 1. Flow Architecture

```
[ PDF Upload (In-Memory) ]
           │
           ▼
[ 1. PDF Text Extraction (pdfjs-dist) ]
     Extracts text rows grouped by y-coordinate & sorted by x.
           │
           ▼
[ 2. Local Profile Extraction (lib/profile.ts) ]
     Extracts name, branch, account number, IFSC locally from first ~40 lines.
     Strips customer header lines before sending to AI.
           │
           ▼
[ 3. AI Extraction (Gemini API via REST fetch) ]
     AI ONLY READS: Extracts structured transactions JSON from masked table text.
     PAN and Email masked; Account numbers preserved for self-transfer checks.
           │
           ▼
[ 4. Balance-Chain Verification & Normalization (lib/ai/normalize.ts) ]
     Chronology reverse check, date normalization (noon timestamps),
     running balance chain verification and auto-direction flip correction.
           │
           ▼
[ 5. Pure Rule-Based Underwriting Engine (lib/analysis/) ]
     100% deterministic code (NO AI hallucination for math or rules):
     - Salary detection (Keyword + Recurring employer)
     - Loan & Obligation tracking (Typical EMI, Partial recovery, Cash before EMI)
     - Credit classification & Self-transfers
     - Circular / Round-trip pair detection
     - Daily median balance, pass-through ratio, and risk signals
     - DSA credit scoring & indicative underwriting verdict
           │
           ▼
[ 6. Interactive UI & Client Recompute (app/statement/page.tsx) ]
     Real-time recalculation in browser when salary credits are toggled or manual salary is input.
```

---

## 2. Environment Variables

Create `.env.local` for local execution (never committed):

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | *(Required)* | Google Gemini API key (server-only, no `NEXT_PUBLIC_` prefix). |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model endpoint name. |
| `AI_CONCURRENCY` | `5` | Maximum parallel page/chunk extraction calls. |
| `ENABLE_AI_INSIGHTS`| `false` | Enables optional Phase 8 AI narrative summary route (`/api/insights`). |

---

## 3. Privacy & Security Constraints

- **Strictly In-Memory**: PDF buffers are parsed in memory using `Uint8Array`. No disk storage, temporary files, databases, or S3 uploads.
- **Privacy Stripping**: All header lines above the transaction table (customer name, residential address, mobile numbers, PAN, branch) are sliced and never sent to the AI endpoint.
- **Data Masking**: PAN (`[A-Z]{5}\d{4}[A-Z]`) and email addresses are regex-masked before chunking.
- **Zero Logging**: Customer names, transaction narrations, account balances, and raw API response bodies are never logged. Errors log only error name and HTTP status codes.
- **Consent Gate**: Form requires explicit client consent before any extraction begins.

---

## 4. Known Limits & Edge Cases

1. **Scanned / Image PDFs**: Statements without embedded OCR text layers will return empty lines; OCR is required for scanned camera photos.
2. **AI Extracted Rows**: AI might occasionally misread a row or flip debit/credit columns; our balance-chain verification automatically corrects flipped directions and flags row count discrepancies.
3. **Keyword Misses & Unclassified Debits**: Unconventional narration text (e.g. non-standard regional cooperative banks) might not match known lender keywords; these are flagged under "Client se poochho" for manual underwriter review.
4. **Indicative Underwriting**: The score and verdict are indicative guidance for DSA agents; final credit approval decisions rest with the lending bank or NBFC.

---

## 5. Development & Testing

```bash
# Run tests (Windows-compatible test runner across lib/**/*.test.ts)
npm test

# Type-check TypeScript strictly
npx tsc --noEmit

# Production build
npm run build

# Start production server
npm start
```
