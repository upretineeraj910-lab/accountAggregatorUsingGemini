import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function findTestFiles(dir) {
  const results = [];
  try {
    const list = readdirSync(dir);
    for (const file of list) {
      const fullPath = join(dir, file);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...findTestFiles(fullPath));
      } else if (file.endsWith(".test.ts")) {
        results.push(fullPath);
      }
    }
  } catch {
    // directory may not exist yet
  }
  return results;
}

const testFiles = findTestFiles("lib");

if (testFiles.length === 0) {
  console.log("No test files found in lib/");
  process.exit(0);
}

console.log(`Running ${testFiles.length} test file(s) with tsx --test:`);
for (const file of testFiles) {
  console.log(` - ${file}`);
}

const isWindows = process.platform === "win32";
const npxCmd = isWindows ? "npx.cmd" : "npx";

const result = spawnSync(npxCmd, ["tsx", "--test", ...testFiles], {
  stdio: "inherit",
  shell: isWindows,
});

process.exit(result.status ?? (result.error ? 1 : 0));
