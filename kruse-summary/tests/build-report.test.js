import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReportHtml } from '../code/build-report.js';

test('curated reports do not append raw forum fallback rows', () => {
  const html = buildReportHtml('2026-05-26', {
    headline_subtitle: 'No selected items for 2026-05-26.',
    sections: [
      { title: 'Twitter Updates', cards: [] },
      { title: 'Forum Updates', cards: [] },
    ],
    forum: { bullets: [] },
  });

  assert.match(html, /Twitter Updates/);
  assert.match(html, /Forum Updates/);
  assert.match(html, /No selected signal/);
  assert.match(html, /Kruse tweeted 4 times\./);
  assert.match(html, /Forum scraper found 33 posts in the last 24 hours\./);
  assert.match(html, /No high-signal updates passed the report gate for 2026-05-26\./);
  assert.doesNotMatch(html, /No selected items for 2026-05-26/);
  assert.doesNotMatch(html, /Forum Updates \(\d+ new/);
  assert.doesNotMatch(html, /See full thread/);
});

test('renderer preserves bold markdown and expandable concept explanations', () => {
  const html = buildReportHtml('2026-05-26', {
    headline_subtitle: 'One useful item.',
    sections: [
      {
        title: 'Twitter Updates',
        cards: [
          {
            tag: 'Twitter',
            lead: 'Mechanism note',
            body: 'Use **mitochondrial context** before {{concept:Doxycycline}} claims.',
            points: ['Explain **why it matters** in plain language.'],
            source_ids: ['2059102359872016427'],
            source_urls: ['https://x.com/DrJackKruse/status/2059102359872016427'],
            source_quote: 'source text',
            concepts: {
              Doxycycline: {
                level: 'noob',
                text: 'An antibiotic that can also affect mitochondrial translation, so it needs context.',
              },
            },
          },
        ],
      },
      { title: 'Forum Updates', cards: [] },
    ],
    forum: { bullets: [] },
  });

  assert.match(html, /<strong>mitochondrial context<\/strong>/);
  assert.match(html, /<strong>why it matters<\/strong>/);
  assert.match(html, /data-concept-level="noob"/);
  assert.match(html, /Doxycycline:<\/strong> An antibiotic/);
});

test('forum cards render clickable source links and unique concept expanders', () => {
  const forumUrl = 'https://forum.jackkruse.com/threads/understanding-vortices.32685/';
  const html = buildReportHtml('2026-05-26', {
    headline_subtitle: 'Two useful items.',
    sections: [
      {
        title: 'Twitter Updates',
        cards: [
          {
            tag: 'Twitter',
            lead: 'Twitter mechanism',
            body: 'Twitter {{concept:shared term}}.',
            source_ids: ['2059102359872016427'],
            concepts: {
              'shared term': { level: 'noob', text: 'Twitter explanation.' },
            },
          },
        ],
      },
      {
        title: 'Forum Updates',
        cards: [
          {
            tag: 'Forum',
            lead: 'Forum mechanism',
            body: 'Forum {{concept:shared term}}.',
            source_urls: [forumUrl],
            concepts: {
              'shared term': { level: 'noob', text: 'Forum explanation.' },
            },
          },
        ],
      },
    ],
    forum: { bullets: [] },
  });

  assert.match(
    html,
    new RegExp(`<a href="${forumUrl}" target="_blank" rel="noopener noreferrer" class="source-link">Read full source`),
  );
  assert.match(html, /onclick="toggleConcept\('c-0-0'\)">shared term<\/span>/);
  assert.match(html, /id="c-0-0" class="expanded-content"[\s\S]*Twitter explanation\./);
  assert.match(html, /onclick="toggleConcept\('c-1-0'\)">shared term<\/span>/);
  assert.match(html, /id="c-1-0" class="expanded-content"[\s\S]*Forum explanation\./);
});
