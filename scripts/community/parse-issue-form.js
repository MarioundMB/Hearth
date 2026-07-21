'use strict';

// GitHub renders a submitted issue form as "### <field label>\n\n<value>\n\n"
// blocks, in field order, with `type: markdown` elements omitted entirely.
// A `render: <lang>` textarea additionally wraps the value in a fenced code
// block, which we strip back off here so callers get the raw value either way.
function parseIssueForm(body) {
  const lines = String(body || '').split(/\r?\n/);
  const sections = {};
  let currentLabel = null;
  let buf = [];

  const flush = () => {
    if (currentLabel === null) return;
    let value = buf.join('\n').trim();
    const fence = value.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/);
    if (fence) value = fence[1];
    if (value === '_No response_') value = '';
    sections[currentLabel] = value;
  };

  for (const line of lines) {
    const heading = line.match(/^### (.+)$/);
    if (heading) {
      flush();
      currentLabel = heading[1].trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();

  return sections;
}

module.exports = { parseIssueForm };
