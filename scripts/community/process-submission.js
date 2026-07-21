'use strict';

// Entry point for .github/workflows/community-submission.yml. Reads the
// triggering issue (via env vars set by the workflow — never interpolated
// directly into a shell `run:` block, see the workflow file), validates it,
// and — if valid — merges the new entry straight into the working tree's
// community/{stacks,themes}/index.json so the workflow can commit it as-is.
//
// Never trust content coming out of this script's *inputs* (issue body) as
// anything other than data: it is only ever JSON.parse()d or regex-matched,
// never eval()d or shelled out.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateStackDefinition, validateThemeCss } = require('../../lib/community-validation');
const { parseIssueForm } = require('./parse-issue-form');

const REPO_ROOT = path.join(__dirname, '..', '..');

function writeOutput(key, rawValue) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const value = String(rawValue).replace(/\r?\n/g, ' ');
  fs.appendFileSync(out, `${key}=${value}\n`);
}

function writeMultilineOutput(key, rawValue) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const delimiter = `EOF_${crypto.randomBytes(12).toString('hex')}`;
  fs.appendFileSync(out, `${key}<<${delimiter}\n${rawValue}\n${delimiter}\n`);
}

function fail(errors) {
  writeOutput('valid', 'false');
  writeMultilineOutput('errors', errors.map(e => `- ${e}`).join('\n'));
  console.error('Validation failed:\n' + errors.map(e => `- ${e}`).join('\n'));
}

function succeed({ title, branch }) {
  writeOutput('valid', 'true');
  writeOutput('title', title);
  writeOutput('branch', branch);
  console.log(`Validation passed: ${title}`);
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'entry';
}

function uniqueId(base, existingIds) {
  let id = base;
  let n = 2;
  while (existingIds.has(id)) id = `${base}-${n++}`;
  return id;
}

function extractCssColors(css) {
  const grab = (name) => {
    const m = css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`, 'i'));
    return m ? m[1].trim() : null;
  };
  return {
    bg: grab('bg'),
    panel: grab('panel'),
    accent: grab('accent'),
    text: grab('text'),
    border: grab('border'),
  };
}

function readIndex(relPath) {
  const filePath = path.join(REPO_ROOT, relPath);
  return { filePath, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
}

function writeIndex(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function processStack(fields, issueAuthor, issueNumber) {
  const name = (fields['Stack name'] || '').trim();
  const jsonRaw = (fields['Stack definition (JSON)'] || '').trim();

  const errors = [];
  if (!name) errors.push('Stack name is missing.');
  if (!jsonRaw) errors.push('Stack definition (JSON) is missing.');

  let stackDef = null;
  if (jsonRaw) {
    try {
      stackDef = JSON.parse(jsonRaw);
    } catch (e) {
      errors.push(`Stack definition is not valid JSON: ${e.message}`);
    }
  }
  if (stackDef) errors.push(...validateStackDefinition(stackDef));
  if (errors.length) return fail(errors);

  const { filePath, data } = readIndex('community/stacks/index.json');
  const existingIds = new Set(data.stacks.map(s => s.id));
  if (existingIds.has(stackDef.id)) {
    return fail([`A stack with id "${stackDef.id}" already exists in the community catalog. Please choose a different id.`]);
  }

  stackDef.name = stackDef.name || name;
  stackDef.description = stackDef.description || (fields['Description'] || '').trim();
  stackDef.author = stackDef.author || issueAuthor;

  data.stacks.push(stackDef);
  writeIndex(filePath, data);

  succeed({
    title: `Add community stack: ${stackDef.name}`,
    branch: `community-submission/issue-${issueNumber}`,
  });
}

function processTheme(fields, issueAuthor, issueNumber) {
  const name = (fields['Theme name'] || '').trim();
  const description = (fields['Description'] || '').trim();
  const authorField = (fields['Author (GitHub username)'] || '').trim();
  const css = (fields['CSS'] || '').trim();

  const errors = [];
  if (!name) errors.push('Theme name is missing.');
  errors.push(...validateThemeCss(css));
  if (errors.length) return fail(errors);

  const { filePath, data } = readIndex('community/themes/index.json');
  const existingIds = new Set(data.themes.map(t => t.id));
  const id = uniqueId(slugify(name), existingIds);
  const colors = extractCssColors(css);

  data.themes.push({
    id,
    name,
    author: authorField || issueAuthor,
    description,
    preview: colors.bg || '#333333',
    colors,
    css,
  });
  writeIndex(filePath, data);

  succeed({
    title: `Add community theme: ${name}`,
    branch: `community-submission/issue-${issueNumber}`,
  });
}

function main() {
  const type = process.env.SUBMISSION_TYPE;
  const issueNumber = process.env.ISSUE_NUMBER;
  const issueAuthor = process.env.ISSUE_AUTHOR || 'community';
  const fields = parseIssueForm(process.env.ISSUE_BODY || '');

  if (type === 'stack') return processStack(fields, issueAuthor, issueNumber);
  if (type === 'theme') return processTheme(fields, issueAuthor, issueNumber);
  return fail([`Unknown submission type: "${type}"`]);
}

main();
