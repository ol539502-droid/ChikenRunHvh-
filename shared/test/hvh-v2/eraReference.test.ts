import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LATE_CSGO } from '../../src/hvh/v2/era';

const docPath = fileURLToPath(new URL('../../../docs/hvh/era-reference.md', import.meta.url));

describe('Era reference document', () => {
  it('every EraTable field has a reference row', () => {
    const markdown = fs.readFileSync(docPath, 'utf8');
    const lines = markdown.split(/\r?\n/);

    const tableRows = lines
      .map(line => line.trim())
      .filter(line => line.startsWith('|') && line.endsWith('|'));

    assert.ok(tableRows.length >= 2, 'Markdown table should have at least a header and data rows');

    // Filter out header and separator rows (|---|---|...)
    const dataRows = tableRows.filter((line, index) => {
      if (index === 0) return false;
      if (/^\|[\s\-:|]+\|$/.test(line)) return false;
      return true;
    });

    const parsedFields = dataRows.map(row => {
      const cols = row.split('|').slice(1, -1);
      return cols[0].trim().replace(/`/g, '');
    });

    const expectedFields = (Object.keys(LATE_CSGO) as Array<keyof typeof LATE_CSGO>).filter(
      key => key !== 'id'
    );

    for (const field of expectedFields) {
      assert.ok(
        parsedFields.includes(field),
        `Missing era reference row for field '${field}'. Found fields: ${parsedFields.join(', ')}`
      );
    }

    // Verify column format for data rows: field | value | meaning (plain English) | source | confidence (high/medium/low)
    for (const row of dataRows) {
      const cols = row.split('|').slice(1, -1).map(c => c.trim());
      assert.equal(cols.length, 5, `Expected 5 columns per row, got ${cols.length} in row: ${row}`);
      const confidence = cols[4].toLowerCase();
      assert.ok(
        ['high', 'medium', 'low'].includes(confidence),
        `Confidence must be high, medium, or low, got '${cols[4]}'`
      );
    }
  });
});
