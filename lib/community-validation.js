'use strict';

// Shared between server.js (POST /api/stacks/custom) and the community
// submission GitHub Action (scripts/community/process-submission.js), so
// the two never drift apart on what counts as a valid stack/theme.

function validateStackDefinition(s) {
  const errors = [];
  if (!s || typeof s !== 'object') { errors.push('Invalid JSON'); return errors; }
  if (!s.id || !/^[a-z0-9_-]+$/.test(s.id)) errors.push('id must be lowercase alphanumeric/dash/underscore');
  if (!s.name || typeof s.name !== 'string') errors.push('name required');
  if (!Array.isArray(s.services) || !s.services.length) {
    errors.push('services array required');
  } else {
    for (const svc of s.services) {
      if (!svc.key || !svc.name || !svc.image) errors.push(`Service missing key/name/image: ${JSON.stringify(svc)}`);
    }
  }
  return errors;
}

function assertValidStackDefinition(s) {
  const errors = validateStackDefinition(s);
  if (errors.length) throw new Error(errors[0]);
}

const CSS_MAX_LENGTH = 20000;
const REQUIRED_CSS_VARS = ['--bg', '--panel', '--accent', '--text', '--border'];

// Community themes are applied as raw <style> textContent (safe from HTML/JS
// injection by construction), but CSS itself can still exfiltrate data via
// url(...) or pull in unreviewed remote content via @import. Submissions go
// through this before a PR is even opened; a maintainer still reviews the
// diff, this just keeps obviously-hostile CSS from wasting that review.
function validateThemeCss(css) {
  const errors = [];
  if (!css || typeof css !== 'string' || !css.trim()) { errors.push('CSS is empty'); return errors; }
  if (css.length > CSS_MAX_LENGTH) errors.push(`CSS is too long (${css.length} chars, max ${CSS_MAX_LENGTH})`);
  if (/@import/i.test(css)) errors.push('@import is not allowed (no remote stylesheet loading)');
  if (/expression\s*\(/i.test(css)) errors.push('CSS expression() is not allowed');
  const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  let m;
  while ((m = urlRe.exec(css)) !== null) {
    const target = m[1].trim();
    if (!/^data:/i.test(target) && !target.startsWith('#')) {
      errors.push(`url(...) must be a data: URI or a local #anchor, found: ${target}`);
    }
  }
  for (const v of REQUIRED_CSS_VARS) {
    if (!css.includes(v)) errors.push(`Missing expected custom property: ${v}`);
  }
  return errors;
}

module.exports = { validateStackDefinition, assertValidStackDefinition, validateThemeCss };
