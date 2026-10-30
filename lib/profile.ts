import { Profile } from "./types";

const LABEL_STRIP_WORDS =
  /^(?:mr|mrs|ms|shri|smt|dr|details|name|branch|customer|address|city|account|holder|sub|base|a\/c|no|code|is|for)[:\s\-.]+/i;
const TRAILING_LABEL_WORDS =
  /[\s:\-]+(?:details|name|branch|customer|address|city|account|holder|a\/c|no|code)$/i;

function cleanString(val: string): string {
  let cleaned = val.replace(/\s+/g, " ").trim();
  // Repeatedly strip leading and trailing label artefacts
  let prev = "";
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned.replace(LABEL_STRIP_WORDS, "").replace(TRAILING_LABEL_WORDS, "").trim();
  }
  return cleaned;
}

function cleanName(raw: string): string | undefined {
  if (!raw) return undefined;
  // If line has multiple column fields, cut off at next field header
  const cutMatch = raw.split(
    /(?:\s+(?:Account|A\/c|Acc|Branch|IFSC|Nominee|Address|Date|Mobile|Phone|Email|Joint|PAN|CIF|Page|Cust\s+Id)\b)|[;:|]/i
  );
  let candidate = cutMatch[0].trim();

  // Strip leading honorifics / labels
  candidate = candidate.replace(/^(?:mr|mrs|ms|shri|smt|dr)\.?\s+/i, "");
  candidate = candidate.replace(/^(?:details\s+)?(?:name\s+)?/i, "");
  candidate = cleanString(candidate);

  if (/^[A-Za-z\s.]{3,50}$/.test(candidate)) {
    // Avoid bank generic headers like "Statement of Account", "Punjab National Bank", "Bank Limited"
    const lower = candidate.toLowerCase();
    if (
      lower.includes("statement") ||
      lower.includes("bank") ||
      lower.includes("transaction") ||
      lower.includes("account") ||
      lower.includes("limited")
    ) {
      return undefined;
    }
    return candidate.toUpperCase();
  }
  return undefined;
}

function cleanBranch(raw: string): string | undefined {
  if (!raw) return undefined;
  // First clean leading noise
  let branch = cleanString(raw);
  // If line has multiple column fields, cut off at next field header
  const cutMatch = branch.split(
    /(?:\s+(?:Account|A\/c|Acc|Customer(?:\s+Name)?|IFSC|Nominee|Address|Date|Mobile|Phone|Email|Joint|PAN|CIF|Page|Cust\s+Id)\b)|[;:|]/i
  );
  branch = cleanString(cutMatch[0]);

  if (/^[A-Za-z0-9\s.,\-\/]{2,40}$/.test(branch) && /[A-Za-z]/.test(branch)) {
    const lower = branch.toLowerCase();
    if (lower.includes("statement") || lower.includes("page")) {
      return undefined;
    }
    return branch.toUpperCase();
  }
  return undefined;
}

function cleanAccountNo(raw: string): string | undefined {
  const m = raw.match(/([0-9Xx*]{6,24})/);
  return m ? m[1] : undefined;
}

function cleanIfsc(raw: string): string | undefined {
  const m = raw.match(/([A-Za-z]{4}0[A-Za-z0-9]{6})/);
  return m ? m[1].toUpperCase() : undefined;
}

export function extractProfile(lines: string[]): Profile {
  const headerLines = lines.slice(0, 50);

  let name: string | undefined;
  let branch: string | undefined;
  let accountNo: string | undefined;
  let ifsc: string | undefined;

  // 1. PNB Patterns
  for (const line of headerLines) {
    if (!name) {
      const match = line.match(/Customer\s+Name\s*:\s*([^,\n;]+)/i);
      if (match) name = cleanName(match[1]);
    }
    if (!branch) {
      const match = line.match(/Branch\s+Name\s*:\s*([^,\n;]+)/i);
      if (match) branch = cleanBranch(match[1]);
    }
    if (!ifsc) {
      const match = line.match(/IFSC(?:\s*Code)?\s*:\s*([A-Za-z0-9]+)/i);
      if (match) ifsc = cleanIfsc(match[1]);
    }
    if (!accountNo) {
      const match = line.match(/Statement\s+of\s+Account\s*:\s*(\d+)/i);
      if (match) accountNo = cleanAccountNo(match[1]);
    }
  }

  // 2. Axis Patterns
  if (!name || !accountNo || !ifsc || !branch) {
    for (let i = 0; i < headerLines.length; i++) {
      const line = headerLines[i];

      // Axis name: line immediately before "Joint Holder"
      if (!name && line.includes("Joint Holder") && i > 0) {
        const candidate = headerLines[i - 1].trim();
        name = cleanName(candidate);
      }

      if (!accountNo) {
        const match = line.match(/Statement\s+of\s+Axis\s+Account\s+No\s*:\s*(\d+)/i);
        if (match) accountNo = cleanAccountNo(match[1]);
      }

      if (!ifsc) {
        const match = line.match(/IFSC\s+Code\s*:\s*([A-Za-z0-9]+)/i);
        if (match) ifsc = cleanIfsc(match[1]);
      }
    }
  }

  // 3. ICICI Patterns
  if (!name || !accountNo || !ifsc || !branch) {
    let seenStatementOfTxn = false;
    for (let i = 0; i < headerLines.length; i++) {
      const line = headerLines[i];
      if (/Statement\s+of\s+Transactions/i.test(line)) {
        seenStatementOfTxn = true;
        continue;
      }

      if (seenStatementOfTxn && !name) {
        const trimmed = line.trim();
        if (/^[A-Z\s.]{3,40}$/.test(trimmed) && !/DATE|TRANSACTION|BALANCE|SAVING|BRANCH|PAGE/i.test(trimmed)) {
          name = cleanName(trimmed);
        }
      }

      if (!branch) {
        const match = line.match(/Your\s+Base\s+Branch\s*:\s*([^,\n;]+)/i);
        if (match) branch = cleanBranch(match[1]);
      }

      if (!accountNo) {
        const match = line.match(/Saving\s+Account\s+no\.?\s*:\s*(\d+)/i);
        if (match) accountNo = cleanAccountNo(match[1]);
      }
    }
  }

  // 4. Universal Bank Patterns (HDFC, SBI, Kotak, BOB, Canara, etc.)
  for (const line of headerLines) {
    if (!name) {
      // Matches Customer Name, Account Name, A/c Name, Name of Account Holder, Name:
      const match = line.match(
        /(?:Customer\s+Name|Account\s+Holder(?:\s+Name)?|Account\s+Name|A\/c\s+Name|Name\s+of\s+Account\s+Holder|Name\s+of\s+Customer|Client\s+Name|Beneficiary\s+Name|Name)\s*[:\-]\s*([^,\n;]+)/i
      );
      if (match) name = cleanName(match[1]);
    }
    if (!branch) {
      const match = line.match(/(?:Branch(?:\s+Name)?|Base\s+Branch)\s*[:\-]\s*([^,\n;]+)/i);
      if (match) branch = cleanBranch(match[1]);
    }
    if (!accountNo) {
      const match = line.match(/(?:A\/c\s+No|Account\s+No|Account\s+Number|Account\s+Id)\s*[:\-\s]\s*([0-9Xx*]{6,24})/i);
      if (match) accountNo = cleanAccountNo(match[1]);
    }
    if (!ifsc) {
      const match = line.match(/(?:IFSC(?:\s*Code)?|RTGS\/NEFT\s+IFSC)\s*[:\-\s]\s*([A-Za-z]{4}0[A-Za-z0-9]{6})/i);
      if (match) ifsc = cleanIfsc(match[1]);
    }
  }

  // 5. Honorific detection fallback (Mr. / Mrs. / Ms. Name on a line by itself)
  if (!name) {
    for (const line of headerLines) {
      const trimmed = line.trim();
      const match = trimmed.match(/^(?:MR|MRS|MS|DR|SHRI|SMT)\.?\s+([A-Z\s.]{3,40})$/i);
      if (match) {
        const candidate = cleanName(match[1]);
        if (candidate) {
          name = candidate;
          break;
        }
      }
    }
  }

  return {
    name,
    branch,
    accountNo,
    ifsc,
  };
}
