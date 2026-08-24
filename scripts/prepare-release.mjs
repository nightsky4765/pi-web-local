import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
const tags = run("git", ["tag", "--list", "v[0-9]*.[0-9]*", "--sort=-v:refname"]).split("\n").filter(Boolean);
const previousTag = tags[0];
const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
const log = run("git", ["log", range, "--pretty=format:%H%x1f%s%x1f%b%x1e"]);
const commits = log.split("\x1e").map((entry) => {
  const [hash = "", subject = "", body = ""] = entry.trim().split("\x1f");
  return { hash, subject: subject.trim(), body: body.trim() };
}).filter((commit) => commit.subject && !commit.subject.startsWith("chore(release):"));

if (!commits.length) {
  console.log("No releasable commits found.");
  process.exit(0);
}

let major;
let minor;
if (!previousTag) {
  major = 1;
  minor = 0;
} else {
  const match = /^v(\d+)\.(\d+)$/.exec(previousTag);
  if (!match) throw new Error(`Unsupported release tag: ${previousTag}`);
  major = Number(match[1]);
  minor = Number(match[2]);
  const breaking = commits.some((commit) => /BREAKING[ -]CHANGE:/i.test(commit.body) || /^[a-z]+(?:\([^)]*\))?!:/i.test(commit.subject));
  if (breaking) {
    major += 1;
    minor = 0;
  } else {
    minor += 1;
  }
}

const tag = `v${major}.${minor}`;
const packageVersion = `${major}.${minor}.0`;
const date = new Date().toISOString().slice(0, 10);
const groups = [
  ["重大變更", (commit) => /BREAKING[ -]CHANGE:/i.test(commit.body) || /^[a-z]+(?:\([^)]*\))?!:/i.test(commit.subject)],
  ["新增", (commit) => /^feat(?:\(|:)/i.test(commit.subject)],
  ["修正", (commit) => /^fix(?:\(|:)/i.test(commit.subject)],
  ["其他變更", () => true],
];
const remaining = [...commits];
const sections = [];
for (const [title, predicate] of groups) {
  const selected = remaining.filter(predicate);
  if (!selected.length) continue;
  sections.push(`### ${title}\n\n${selected.map((commit) => `- ${cleanSubject(commit.subject)} (\`${commit.hash.slice(0, 7)}\`)`).join("\n")}`);
  for (const commit of selected) remaining.splice(remaining.indexOf(commit), 1);
}
const notes = `## ${tag} - ${date}\n\n${sections.join("\n\n")}\n`;

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
packageJson.version = packageVersion;
writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.version = packageVersion;
if (lock.packages?.[""]) lock.packages[""].version = packageVersion;
writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);

let changelog = "# Changelog\n\n本專案的所有重要變更都會記錄在此。\n";
try { changelog = readFileSync("CHANGELOG.md", "utf8").trimEnd(); } catch {}
const description = "本專案的所有重要變更都會記錄在此。";
const descriptionEnd = changelog.indexOf(description);
const insertAt = descriptionEnd >= 0 ? descriptionEnd + description.length : changelog.length;
changelog = `${changelog.slice(0, insertAt).trimEnd()}\n\n${notes}\n${changelog.slice(insertAt).trimStart()}`.trimEnd() + "\n";
writeFileSync("CHANGELOG.md", changelog);
writeFileSync(".release-notes.md", `${notes}\n`);

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nversion=${packageVersion}\n`, { flag: "a" });
}
console.log(`Prepared ${tag} (${packageVersion})`);

function cleanSubject(subject) {
  return subject.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, "").trim();
}
