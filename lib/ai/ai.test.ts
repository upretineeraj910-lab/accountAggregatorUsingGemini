import { describe, it } from "node:test";
import assert from "node:assert";
import { isAnchorLine, countExpectedRows, normalizeRows } from "./normalize";
import { extractWithAi, stripHeaderLines, maskSensitiveData, prepareChunks, AiExtractError, CallFn } from "./extract";
import { RawAiRow } from "../types";
import { PAGE } from "../pdfText";

describe("Phase 2 - normalizeRows & anchor detection", () => {
  it("matches valid anchor lines and rejects header/footer lines", () => {
    assert.strictEqual(isAnchorLine("22/10/2026 700.0 DR UPI/123/Transfer"), true);
    assert.strictEqual(isAnchorLine("1 01.07.2026 Lingala Sa"), true);
    assert.strictEqual(isAnchorLine("30-04-2026 Transfer from ABC"), true);
    assert.strictEqual(isAnchorLine("15 Jan 2026 Salary Credit"), true);

    // Negative matches (footers / meta)
    assert.strictEqual(isAnchorLine("Date: 22/10/2026 17:47:62 Page 1"), false);
    assert.strictEqual(isAnchorLine("Generated on Date 22/10/2026"), false);
    assert.strictEqual(isAnchorLine("OPENING BALANCE 25000.00"), false);
    assert.strictEqual(isAnchorLine("Branch IFSC: PUNB0123400"), false);
  });

  it("counts expected rows accurately", () => {
    const lines = [
      "Header line",
      "22/10/2026 500 DR ATM",
      "Some description continuation",
      "23/10/2026 1000 CR UPI",
      "Date: 22/10/2026 Page 1",
      "24/10/2026 200 DR FOOD",
    ];
    assert.strictEqual(countExpectedRows(lines), 3);
  });

  it("reverses newest-first chronological order", () => {
    const raw: RawAiRow[] = [
      { date: "2026-10-05", narration: "Later txn", amount: 1000, type: "DEBIT", balance: 9000 },
      { date: "2026-10-01", narration: "Earlier txn", amount: 10000, type: "CREDIT", balance: 10000 },
    ];
    const { txns } = normalizeRows(raw, 2);
    assert.strictEqual(txns.length, 2);
    assert.strictEqual(txns[0].narration, "Earlier txn");
    assert.strictEqual(txns[1].narration, "Later txn");
  });

  it("corrects wrong transaction direction using balance chain (flippedByChain)", () => {
    const raw: RawAiRow[] = [
      { date: "2026-05-01", narration: "Txn 1", amount: 5000, type: "CREDIT", balance: 15000 },
      // AI incorrectly classified this deposit as DEBIT, but balance increased by 2000 (15000 -> 17000)
      { date: "2026-05-02", narration: "Txn 2", amount: 2000, type: "DEBIT", balance: 17000 },
      // AI incorrectly classified this withdrawal as CREDIT, but balance decreased by 3000 (17000 -> 14000)
      { date: "2026-05-03", narration: "Txn 3", amount: 3000, type: "CREDIT", balance: 14000 },
      { date: "2026-05-04", narration: "Txn 4", amount: 1000, type: "DEBIT", balance: 13000 },
      { date: "2026-05-05", narration: "Txn 5", amount: 2000, type: "CREDIT", balance: 15000 },
    ];
    const { txns, quality } = normalizeRows(raw, 5, 10000);
    assert.strictEqual(quality.flippedByChain, 2);
    assert.strictEqual(txns[1].credit, 2000);
    assert.strictEqual(txns[1].debit, 0);
    assert.strictEqual(txns[2].debit, 3000);
    assert.strictEqual(txns[2].credit, 0);
    assert.strictEqual(quality.chainMismatches, 0);
    assert.strictEqual(quality.ok, true);
  });

  it("increments chainMismatches when balance jump does not match amount (missing row)", () => {
    const raw: RawAiRow[] = [
      { date: "2026-05-01", narration: "Txn 1", amount: 5000, type: "CREDIT", balance: 15000 },
      // Balance jumps from 15000 to 25000, but amount is only 1000
      { date: "2026-05-02", narration: "Txn 2", amount: 1000, type: "CREDIT", balance: 25000 },
    ];
    const { quality } = normalizeRows(raw, 2);
    assert.strictEqual(quality.chainMismatches, 1);
  });

  it("drops invalid raw rows and flags firstRowUncertain if opening balance is missing", () => {
    const raw: RawAiRow[] = [
      // Valid
      { date: "2026-01-01", narration: "Valid 1", amount: 100, type: "CREDIT", balance: 100 },
      // Invalid date
      { date: "invalid-date", narration: "Bad date", amount: 100, type: "CREDIT", balance: 200 },
      // Invalid amount
      { date: "2026-01-02", narration: "Bad amt", amount: NaN, type: "CREDIT", balance: 200 },
      // Invalid type
      { date: "2026-01-03", narration: "Bad type", amount: 50, type: "OTHER" as any, balance: 150 },
    ];
    const { txns, quality } = normalizeRows(raw, 4);
    assert.strictEqual(txns.length, 1);
    assert.strictEqual(quality.dropped, 3);
    assert.strictEqual(quality.firstRowUncertain, true);
  });
});

describe("Phase 2 - extractWithAi privacy, chunking and retry", () => {
  it("strips header lines above the table header to preserve privacy", () => {
    const lines = [
      "Punjab National Bank",
      "Customer Name: JOHN DOE",
      "Account No: 1234567890",
      "Branch: Sector 62 Noida",
      "Date Particulars Debit Credit Balance",
      "01/10/2026 Opening Balance 10000",
      "02/10/2026 UPI/Transfer 500 9500",
    ];

    const { strippedLines } = stripHeaderLines(lines);
    assert.strictEqual(strippedLines.length, 2);
    assert.strictEqual(strippedLines[0], "01/10/2026 Opening Balance 10000");
    assert.strictEqual(strippedLines[1], "02/10/2026 UPI/Transfer 500 9500");
  });

  it("throws HEADER_NOT_FOUND when header is missing unless allowFullTextIfNoHeader is true", () => {
    const lines = ["Customer Details", "Line 2", "Line 3"];
    assert.throws(() => stripHeaderLines(lines, false), (err: unknown) => {
      return err instanceof AiExtractError && err.code === "HEADER_NOT_FOUND";
    });

    const res = stripHeaderLines(lines, true);
    assert.strictEqual(res.strippedLines.length, 3);
  });

  it("masks PAN and email addresses", () => {
    const text = "Customer PAN ABCDE1234F and email user.test@example.com transfer";
    const masked = maskSensitiveData(text);
    assert.strictEqual(masked.includes("ABCDE1234F"), false);
    assert.strictEqual(masked.includes("user.test@example.com"), false);
    assert.strictEqual(masked.includes("[PAN_MASKED]"), true);
    assert.strictEqual(masked.includes("[EMAIL_MASKED]"), true);
  });

  it("chunks pages and splits 60+ anchor lines with 4 lines overlap", () => {
    const lines: string[] = [PAGE];
    for (let i = 1; i <= 70; i++) {
      lines.push(`${String(i).padStart(2, "0")}/05/2026 Txn ${i} 100 CR 1000`);
    }

    const chunks = prepareChunks(lines);
    assert.ok(chunks.length >= 2, "Should split into multiple sub-chunks");
    assert.ok(chunks[0].lines.length > 40);
  });

  it("extracts with AI using mock caller, retries on low rows, and dedupes overlap", async () => {
    let callCount = 0;
    const mockCall: CallFn = async (payload) => {
      callCount++;
      const userText = payload.contents[0].parts[0].text;

      // First call for page returns 1 row (triggering retry because 5 anchors expected)
      if (callCount === 1) {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      transactions: [
                        { date: "2026-05-01", narration: "Txn 1", amount: 1000, type: "CREDIT", balance: 11000 },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        };
      }

      // Second call returns all rows
      return {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    transactions: [
                      { date: "2026-05-01", narration: "Txn 1", amount: 1000, type: "CREDIT", balance: 11000 },
                      { date: "2026-05-02", narration: "Txn 2", amount: 500, type: "DEBIT", balance: 10500 },
                      { date: "2026-05-03", narration: "Txn 3", amount: 200, type: "DEBIT", balance: 10300 },
                      { date: "2026-05-04", narration: "Txn 4", amount: 100, type: "DEBIT", balance: 10200 },
                      { date: "2026-05-05", narration: "Txn 5", amount: 50, type: "DEBIT", balance: 10150 },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      };
    };

    const lines = [
      "Punjab National Bank",
      "PAN: ABCDE1234F email: test@example.com",
      "Date Particulars Debit Credit Balance",
      "01/05/2026 Txn 1 1000 CR 11000",
      "02/05/2026 Txn 2 500 DR 10500",
      "03/05/2026 Txn 3 200 DR 10300",
      "04/05/2026 Txn 4 100 DR 10200",
      "05/05/2026 Txn 5 50 DR 10150",
    ];

    const res = await extractWithAi(lines, { call: mockCall });
    assert.strictEqual(res.txns.length, 5);
    assert.strictEqual(callCount, 2, "Should have retried chunk once");
    assert.strictEqual(res.quality.ok, true);
  });
});
