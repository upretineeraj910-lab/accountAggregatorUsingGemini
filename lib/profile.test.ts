import { describe, it } from "node:test";
import assert from "node:assert";
import { extractProfile } from "./profile";

describe("Phase 3 - extractProfile with fake bank headers", () => {
  it("extracts profile details from fake PNB header", () => {
    const fakePnbLines = [
      "PUNJAB NATIONAL BANK",
      "Customer Name: RAJESH KUMAR SHARMA",
      "Statement of Account: 0361201100001234",
      "Branch Name: NOIDA SECTOR 62",
      "IFSC: PUNB0036120",
      "Date Particulars Debit Credit Balance",
    ];

    const profile = extractProfile(fakePnbLines);
    assert.strictEqual(profile.name, "RAJESH KUMAR SHARMA");
    assert.strictEqual(profile.accountNo, "0361201100001234");
    assert.strictEqual(profile.branch, "NOIDA SECTOR 62");
    assert.strictEqual(profile.ifsc, "PUNB0036120");
  });

  it("extracts profile details from fake Axis header", () => {
    const fakeAxisLines = [
      "AXIS BANK LTD",
      "Statement of Axis Account No: 918010012345678",
      "PRIYA S VERMA",
      "Joint Holder: NONE",
      "IFSC Code: UTIB0000123",
      "Branch: CONNAUGHT PLACE",
    ];

    const profile = extractProfile(fakeAxisLines);
    assert.strictEqual(profile.name, "PRIYA S VERMA");
    assert.strictEqual(profile.accountNo, "918010012345678");
    assert.strictEqual(profile.ifsc, "UTIB0000123");
    assert.strictEqual(profile.branch, "CONNAUGHT PLACE");
  });

  it("extracts profile details from fake ICICI header", () => {
    const fakeIciciLines = [
      "ICICI BANK LIMITED",
      "Saving Account no: 001101567890",
      "Statement of Transactions",
      "AMIT ANAND PATEL",
      "Your Base Branch: BANDRA KURLA COMPLEX",
      "IFSC Code: ICIC0000011",
    ];

    const profile = extractProfile(fakeIciciLines);
    assert.strictEqual(profile.name, "AMIT ANAND PATEL");
    assert.strictEqual(profile.accountNo, "001101567890");
    assert.strictEqual(profile.branch, "BANDRA KURLA COMPLEX");
    assert.strictEqual(profile.ifsc, "ICIC0000011");
  });

  it("strips leftover labels like 'Details Name MATIA' from branch and name", () => {
    const noisyLines = [
      "Customer Name: Details Name MATIA DAS",
      "Branch Name: Details Name MATIA",
      "Statement of Account: 1234567890",
      "IFSC: HDFC0001234",
    ];

    const profile = extractProfile(noisyLines);
    assert.strictEqual(profile.name, "MATIA DAS");
    assert.strictEqual(profile.branch, "MATIA");
  });

  it("returns undefined for invalid garbage or bank headers", () => {
    const invalidLines = [
      "Statement of Account: 12345",
      "Customer Name: 123456",
      "Branch Name: --",
    ];

    const profile = extractProfile(invalidLines);
    assert.strictEqual(profile.name, undefined);
    assert.strictEqual(profile.branch, undefined);
  });
});
