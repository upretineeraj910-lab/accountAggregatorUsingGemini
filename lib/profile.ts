import { Profile } from "./types";

const LABEL_STRIP_WORDS = /^(?:details|name|branch|customer|address|city|account|holder|sub|base|a\/c|no|code|is|for)[:\s\-]+/i;
const TRAILING_LABEL_WORDS = /[\s:\-]+(?:details|name|branch|customer|address|city|account|holder|a\/c|no|code)$/i;

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
  let name = cleanString(raw);
  // Specifically remove leftover words if present at start, e.g. "Details Name MATIA" -> "MATIA"
  name = name.replace(/^(?:details\s+)?(?:name\s+)?/i, "").trim();
  if (/^[A-Za-z\s.]{3,40}$/.test(name)) {
    // Avoid bank generic headers like "Statement of Account", "Punjab National Bank"
    const lower = name.toLowerCase();
    if (
      lower.includes("statement") ||
      lower.includes("bank") ||
      lower.includes("transaction") ||
      lower.includes("account")
    ) {
      return undefined;
    }
    return name;
  }
  return undefined;
}

function cleanBranch(raw: string): string | undefined {
  let branch = cleanString(raw);
  // Strip leftover label words like "Details Name", "Branch Name"
  branch = branch.replace(/^(?:details\s+)?(?:name\s+)?(?:branch\s+)?/i, "").trim();
  if (/^[A-Za-z0-9\s.,\-\/]{2,40}$/.test(branch) && /[A-Za-z]/.test(branch)) {
    const lower = branch.toLowerCase();
    if (lower.includes("statement") || lower.includes("page")) {
      return undefined;
    }
    return branch;
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
  const headerLines = lines.slice(0, 40);

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

      // First ALL-CAPS name line after "Statement of Transactions"
      if (seenStatementOfTxn && !name) {
        const trimmed = line.trim();
        // Check if all caps letters (at least 3 chars) and not a keyword
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

  // 4. Generic fallbacks across the first 40 lines
  for (const line of headerLines) {
    if (!name) {
      const match = line.match(/(?:Account\s+Holder|Customer|Client)\s*(?:Name)?\s*:\s*([^,\n;]+)/i);
      if (match) name = cleanName(match[1]);
    }
    if (!branch) {
      const match = line.match(/(?:Branch(?:\s+Name)?|Base\s+Branch)\s*:\s*([^,\n;]+)/i);
      if (match) branch = cleanBranch(match[1]);
    }
    if (!accountNo) {
      const match = line.match(/(?:A\/c\s+No|Account\s+No|Account\s+Number)\s*[:\s]\s*([0-9Xx*]{6,24})/i);
      if (match) accountNo = cleanAccountNo(match[1]);
    }
    if (!ifsc) {
      const match = line.match(/IFSC(?:\s*Code)?\s*[:\s]\s*([A-Za-z]{4}0[A-Za-z0-9]{6})/i);
      if (match) ifsc = cleanIfsc(match[1]);
    }
  }

  return {
    name,
    branch,
    accountNo,
    ifsc,
  };
}
