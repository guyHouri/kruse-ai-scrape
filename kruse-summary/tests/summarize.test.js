import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dropPodcastDeferredCards,
  gateSelection,
  hasVerifiableCitation,
  repairConceptAliases,
  repairPrivatePhraseConcepts,
  repairReportVoice,
  repairRequiredTranslationConcepts,
  repairSelectionCitations,
  repairSummaryCitations,
  repairSummaryCardSources,
  repairSummarySourceQuotes,
  repairSelectionCoverage,
  validateReportVoice,
  validatePlainTopicLanguage,
  shouldUseAnthropicStreaming,
} from '../code/summarize.js';

test('large Anthropic output budgets use streaming mode', () => {
  assert.equal(shouldUseAnthropicStreaming(19999), false);
  assert.equal(shouldUseAnthropicStreaming(20000), true);
  assert.equal(shouldUseAnthropicStreaming(32000), true);
});

test('repairConceptAliases fills missing concept tags from fallback explanations', () => {
  const repaired = repairConceptAliases({
    sections: [
      {
        title: 'Twitter Updates',
        cards: [
          {
            lead: 'Physics term needs an exact concept key',
            body: 'The card references {{concept:fractional-charge}} behavior.',
            points: [],
            concepts: {},
          },
        ],
      },
    ],
  });

  assert.match(
    repaired.sections[0].cards[0].concepts['fractional-charge'].text,
    /technical term|fractional-charge/i,
  );
});

test('gateSelection keeps Jack-authored priority-3 geo forum signals', () => {
  const gated = gateSelection({
    selected_items: [
      {
        source_type: 'forum',
        source_id: 'forum-ancients',
        source_authority: 'jack',
        priority: 3,
        value_type: 'geo',
        title: 'THE ANCIENTS...........WHAT DID THEY KNOW?',
      },
      {
        source_type: 'tweet',
        source_id: 'tweet-low',
        source_authority: 'jack',
        priority: 3,
        value_type: 'commentary',
        title: 'Low value tweet',
      },
    ],
    dropped_items: [],
    unselected_items: [],
  });

  assert.deepEqual(gated.selected_items.map((item) => item.source_id), ['forum-ancients']);
  assert.equal(gated.dropped_items.at(-1).source_id, 'tweet-low');
});

test('dropPodcastDeferredCards removes podcast-only report cards', () => {
  const summary = {
    sections: [
      {
        title: 'Twitter Updates',
        cards: [
          { lead: 'Keep', source_ids: ['tweet-1'], points: [] },
          { lead: 'Drop podcast', source_ids: ['podcast-1'], points: [] },
          { lead: 'Drop contaminated', source_ids: ['tweet-2', 'podcast-2'], points: [] },
        ],
      },
    ],
  };

  const repaired = dropPodcastDeferredCards(summary, [
    { source_id: 'podcast-1' },
    { source_id: 'podcast-2' },
  ]);

  assert.deepEqual(repaired.sections[0].cards.map((card) => card.lead), ['Keep']);
});

test('repairSummaryCardSources restores missing tweet source IDs from selected items', () => {
  const summary = {
    headline_subtitle: 'Daily source-bound update',
    sections: [
      {
        title: 'Twitter Updates',
        cards: [
          {
            lead: 'Blood flow follows vortex mechanics',
            body: 'Kruse frames blood flow as vortex coherence instead of linear hydraulics.',
            source_quote: 'MAP and CBF depend on vortex coherence',
            points: [],
          },
        ],
      },
      { title: 'Forum Updates', cards: [] },
    ],
  };
  const selection = {
    selected_items: [
      {
        source_type: 'tweet',
        source_id: 'tweet-vortex-1',
        title: 'Blood flow follows helical vortex mechanics',
        support_quotes: ['MAP and CBF depend on vortex coherence'],
      },
    ],
  };

  const repaired = repairSummaryCardSources(summary, selection);

  assert.deepEqual(repaired.sections[0].cards[0].source_ids, ['tweet-vortex-1']);
});

test('repairSummaryCardSources restores missing forum URLs from selected items', () => {
  const forumUrl = 'https://forum.jackkruse.com/threads/the-ancients.17876/';
  const summary = {
    headline_subtitle: 'Daily source-bound update',
    sections: [
      { title: 'Twitter Updates', cards: [] },
      {
        title: 'Forum Updates',
        cards: [
          {
            lead: 'Ancient-build thread links architecture to field sensing',
            body: 'The forum update is about ancient builders and biological signal environments.',
            source_quote: 'what did they know',
            points: [],
          },
        ],
      },
    ],
  };
  const selection = {
    selected_items: [
      {
        source_type: 'forum',
        source_id: forumUrl,
        source_url: forumUrl,
        title: 'THE ANCIENTS...........WHAT DID THEY KNOW?',
        support_quotes: ['what did they know'],
      },
    ],
  };

  const repaired = repairSummaryCardSources(summary, selection);

  assert.deepEqual(repaired.sections[1].cards[0].source_urls, [forumUrl]);
});

test('repairSummaryCardSources replaces forum URLs not present in selected input', () => {
  const validForumUrl = 'https://forum.jackkruse.com/threads/valid-thread.123/';
  const invalidForumUrl = 'https://forum.jackkruse.com/threads/model-invented-thread.999/';
  const summary = {
    headline_subtitle: 'Daily source-bound update',
    sections: [
      { title: 'Twitter Updates', cards: [] },
      {
        title: 'Forum Updates',
        cards: [
          {
            lead: 'NAD+ quantum oscillator note',
            body: 'The card discusses NAD+ and oscillator synchronization.',
            source_quote: 'NAD+ as oscillator synchronization',
            source_urls: [invalidForumUrl],
            points: [],
          },
        ],
      },
    ],
  };
  const selection = {
    selected_items: [
      {
        source_type: 'forum',
        source_id: validForumUrl,
        source_url: validForumUrl,
        title: 'NAD+ quantum oscillator note',
        source_claim: 'NAD+ as oscillator synchronization',
        support_quotes: ['NAD+ as oscillator synchronization'],
      },
    ],
  };

  const repaired = repairSummaryCardSources(summary, selection);

  assert.deepEqual(repaired.sections[1].cards[0].source_urls, [validForumUrl]);
});

test('repairSummarySourceQuotes replaces hallucinated quotes with same-day source text', () => {
  const repaired = repairSummarySourceQuotes({
    sections: [
      {
        title: 'Twitter Updates',
        cards: [
          {
            lead: 'Bad source quote',
            body: 'The card is source-linked but quote text was paraphrased.',
            source_quote: 'this sentence was never in the source',
            source_ids: ['12345'],
            points: [],
          },
        ],
      },
    ],
  }, {
    twitter: {
      tweets: [{
        id: '12345',
        text: 'Exact source sentence appears here. This second source sentence is long enough for fallback repair.',
      }],
    },
    forum: { posts: [] },
  }, {
    selected_items: [{ source_type: 'tweet', source_id: '12345', support_quotes: [] }],
  });

  assert.match(repaired.sections[0].cards[0].source_quote, /Exact source sentence appears here/);
});

test('citation guard rejects vague review labels without bibliographic anchors', () => {
  assert.equal(hasVerifiableCitation({
    paper: 'Narrative review in Clinical Bioenergetics (referenced in quoted tweet by @dantawfik)',
    claim: 'Cancer mitochondria are hyperpolarized.',
  }), false);

  assert.equal(hasVerifiableCitation({
    paper: 'Tawfik et al. 2026, Clinical Bioenergetics',
    claim: 'Cancer mitochondria are hyperpolarized.',
  }), true);
});

test('citation repair removes weak selection and rendered citations', () => {
  const selection = repairSelectionCitations({
    selected_items: [
      {
        source_id: 'tweet-1',
        source_citations: [
          { paper: 'Narrative review in Clinical Bioenergetics', claim: 'too vague' },
          { paper: 'Tawfik et al. 2026, Clinical Bioenergetics', claim: 'verifiable' },
        ],
      },
    ],
  });
  assert.deepEqual(selection.selected_items[0].source_citations.map((c) => c.paper), [
    'Tawfik et al. 2026, Clinical Bioenergetics',
  ]);

  const summary = repairSummaryCitations({
    sections: [
      {
        title: 'Twitter Updates',
        cards: [
          {
            lead: 'Cancer mitochondrial hyperpolarization',
            citations: [
              { paper: 'Narrative review in Clinical Bioenergetics', claim: 'too vague' },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(summary.sections[0].cards[0].citations, []);
});

test('repairReportVoice removes absence/opinion language before validation', () => {
  const summary = {
    headline_subtitle: 'Daily source-bound update',
    sections: [
      {
        title: 'Twitter Updates',
        cards: [
          {
            lead: 'Magnetic signal affects oxygen handling',
            body: 'Kruse links magnetic field destabilization to oxygen handling and dopamine synthesis. Trial data was not provided in the source.',
            points: [
              'The mechanism connects triplet oxygen state to dopamine synthesis.',
              'The source does not provide dosing or trial data.',
            ],
            concepts: {
              'triplet oxygen': {
                level: 'noob',
                text: 'The normal magnetic state of oxygen; likely refers to a broader oxygen signaling claim.',
              },
            },
          },
        ],
      },
    ],
  };

  const repaired = repairReportVoice(summary);

  assert.doesNotThrow(() => validateReportVoice(repaired));
  assert.equal(repaired.sections[0].cards[0].points.length, 1);
  assert.match(repaired.sections[0].cards[0].concepts['triplet oxygen'].text, /refers to/);
});

test('plain topic language gate rejects jargon-first card labels', () => {
  assert.throws(() => validatePlainTopicLanguage({
    sections: [
      {
        title: 'Forum Updates',
        cards: [
          {
            tag: 'SSRI deuteration singlet trap',
            lead: 'SSRI-induced suicidality involves deuteration, NAD+ depletion, and oxygen spin-state inversion',
          },
        ],
      },
    ],
  }), /plain topic language failed/);

  assert.doesNotThrow(() => validatePlainTopicLanguage({
    sections: [
      {
        title: 'Forum Updates',
        cards: [
          {
            tag: 'SSRI risk warning',
            lead: 'A forum post links SSRI suicidality to a mitochondrial stress pattern',
          },
        ],
      },
    ],
  }));
});

test('repairSelectionCoverage turns omitted sources into audit-only drops', () => {
  const repaired = repairSelectionCoverage({
    twitter: { tweets: [{ id: '12345', text: 'small note' }] },
    forum: {
      posts: [
        {
          thread_url: 'https://forum.jackkruse.com/threads/the-ancients.17876/',
          thread_title: 'THE ANCIENTS...........WHAT DID THEY KNOW?',
          author: 'Jack Kruse',
        },
      ],
    },
  }, {
    selected_items: [],
    unselected_items: [{ source_type: 'tweet', source_id: '12345' }],
  });

  assert.equal(repaired.unselected_items.length, 2);
  assert.equal(repaired.unselected_items[1].source_type, 'forum');
  assert.equal(repaired.unselected_items[1].source_authority, 'jack');
  assert.equal(repaired.unselected_items[1].reason_category, 'model_omitted');
});

test('repairSelectionCoverage removes duplicate source classifications', () => {
  const repaired = repairSelectionCoverage({
    twitter: { tweets: [{ id: '12345', text: 'small note' }] },
    forum: { posts: [] },
  }, {
    selected_items: [{ source_type: 'tweet', source_id: '12345', title: 'selected' }],
    unselected_items: [{ source_type: 'tweet', source_id: '12345', reason: 'duplicate reject' }],
  });

  assert.equal(repaired.selected_items.length, 1);
  assert.equal(repaired.unselected_items.length, 0);
});

test('repairSelectionCoverage removes source classifications not present in input', () => {
  const repaired = repairSelectionCoverage({
    twitter: { tweets: [{ id: '12345', text: 'small note' }] },
    forum: { posts: [] },
  }, {
    selected_items: [
      { source_type: 'tweet', source_id: '12345', title: 'selected' },
      { source_type: 'tweet', source_id: '1234599999', title: 'bogus model id' },
    ],
    unselected_items: [
      { source_type: 'forum', source_id: 'https://forum.jackkruse.com/threads/missing.9999/' },
    ],
  });

  assert.deepEqual(repaired.selected_items.map((item) => item.source_id), ['12345']);
  assert.equal(repaired.unselected_items.length, 0);
});


test('repairRequiredTranslationConcepts explains slash-normalized science terms', () => {
  const summary = {
    sections: [
      {
        title: 'Forum',
        cards: [
          {
            lead: 'Internal water collapse drives charge accumulation',
            body: 'Grounding/uninsulated state changes the model.',
            points: [],
            concepts: {},
            source_urls: ['https://forum.jackkruse.com/threads/hypermobility-ehlers-danios-syndrome.29636/'],
          },
        ],
      },
    ],
  };
  const selection = {
    selected_items: [
      {
        source_type: 'forum',
        source_id: 'https://forum.jackkruse.com/threads/hypermobility-ehlers-danios-syndrome.29636/',
        source_url: 'https://forum.jackkruse.com/threads/hypermobility-ehlers-danios-syndrome.29636/',
        title: 'Internal water collapse drives charge accumulation',
        translation_terms: ['grounding/uninsulated'],
      },
    ],
  };

  const repaired = repairRequiredTranslationConcepts(summary, selection);
  const [card] = repaired.sections[0].cards;

  assert.match(card.body, /\{\{concept:Grounding\/uninsulated\}\}/);
  assert.match(card.concepts['grounding/uninsulated'].text, /conductive path to the earth/);
});

test('repairRequiredTranslationConcepts explains common medical and Kruse science terms', () => {
  const summary = {
    sections: [
      {
        title: 'Forum',
        cards: [
          {
            lead: 'GERD and hypothyroidism share charge failures',
            body: 'The source links GERD, hypothyroidism, nnEMF, deuterium, and dielectric collapse.',
            points: [],
            concepts: {},
            source_urls: ['https://forum.jackkruse.com/threads/gerd.1/'],
          },
        ],
      },
    ],
  };
  const selection = {
    selected_items: [
      {
        source_type: 'forum',
        source_id: 'https://forum.jackkruse.com/threads/gerd.1/',
        source_url: 'https://forum.jackkruse.com/threads/gerd.1/',
        title: 'GERD and hypothyroidism share charge failures',
        translation_terms: [
          'deuterium (D+)',
          'nnEMF (non-native electromagnetic field)',
          'dielectric collapse',
          'gastroesophageal reflux disease (GERD)',
          'hypothyroidism',
        ],
      },
    ],
  };

  const repaired = repairRequiredTranslationConcepts(summary, selection);
  const concepts = repaired.sections[0].cards[0].concepts;

  assert.match(concepts['deuterium (D+)'].text, /heavier form of hydrogen|heavy hydrogen/i);
  assert.match(concepts['nnEMF (non-native electromagnetic field)'].text, /artificial|non-native electromagnetic/i);
  assert.match(concepts['dielectric collapse'].text, /charge-storage/);
  assert.match(concepts['gastroesophageal reflux disease (GERD)'].text, /acid reflux|chronic reflux/i);
  assert.match(concepts.hypothyroidism.text, /thyroid hormone/i);
});

test('repairRequiredTranslationConcepts explains advanced mechanism terms from live reports', () => {
  const summary = {
    sections: [
      {
        title: 'Forum',
        cards: [
          {
            lead: 'Deuterium and oxygen spin states affect tissue voltage',
            body: 'The source mentions protium, infrared, reduced mass, singlet oxygen, collagen cross-linking, LES, spin-coherence, geomagnetic reference frame, fluid dynamics, and permittivity.',
            points: [],
            concepts: {},
            source_urls: ['https://forum.jackkruse.com/threads/live-terms.1/'],
          },
        ],
      },
    ],
  };
  const selection = {
    selected_items: [
      {
        source_type: 'forum',
        source_id: 'https://forum.jackkruse.com/threads/live-terms.1/',
        source_url: 'https://forum.jackkruse.com/threads/live-terms.1/',
        title: 'Deuterium and oxygen spin states affect tissue voltage',
        translation_terms: [
          'protium (1H)',
          'infrared (0.66 eV pulse)',
          'reduced mass (mu)',
          'singlet oxygen',
          'collagen cross-linking',
          'Lower Esophageal Sphincter (LES)',
          'spin-coherence',
          'geomagnetic reference frame',
          'fluid dynamics',
          'permittivity',
        ],
      },
    ],
  };

  const repaired = repairRequiredTranslationConcepts(summary, selection);
  const concepts = repaired.sections[0].cards[0].concepts;

  assert.match(concepts['protium (1H)'].text, /ordinary light hydrogen/i);
  assert.match(concepts['infrared (0.66 eV pulse)'].text, /infrared/i);
  assert.match(concepts['reduced mass (mu)'].text, /bond vibration/i);
  assert.match(concepts['singlet oxygen'].text, /excited form of oxygen/i);
  assert.match(concepts['collagen cross-linking'].text, /collagen fibers/i);
  assert.match(concepts['Lower Esophageal Sphincter (LES)'].text, /muscle valve/i);
  assert.match(concepts['spin-coherence'].text, /spin behavior/i);
  assert.match(concepts['geomagnetic reference frame'].text, /earth's magnetic-field/i);
  assert.match(concepts['fluid dynamics'].text, /liquids and gases move/i);
  assert.match(concepts.permittivity.text, /stores electrical energy/i);
});

test('repairRequiredTranslationConcepts treats blog IDs as archive references', () => {
  const summary = {
    sections: [
      {
        title: 'Twitter Updates',
        cards: [
          {
            lead: 'Protein load connects to DM#63',
            body: 'The source uses DM#63 as the archive anchor for this protein-load claim.',
            points: [],
            concepts: {},
            source_ids: ['tweet-dm-63'],
          },
        ],
      },
    ],
  };
  const selection = {
    selected_items: [
      {
        source_type: 'tweet',
        source_id: 'tweet-dm-63',
        title: 'Protein load connects to DM#63',
        translation_terms: ['DM#63'],
        blog_refs: [{ code: 'DM#63', title: 'Protein and Deuterium', series: 'DM', number: 63 }],
      },
    ],
  };

  const repaired = repairRequiredTranslationConcepts(summary, selection);
  const concept = repaired.sections[0].cards[0].concepts['DM#63'];

  assert.match(concept.text, /Kruse blog\/article archive reference/);
  assert.match(concept.text, /not a formal scientific citation/);
  assert.doesNotMatch(concept.text, /technical term used by the selected source/i);
});

test('repairPrivatePhraseConcepts explains Kruse shorthand when the model forgets', () => {
  const repaired = repairPrivatePhraseConcepts({
    sections: [
      {
        title: 'Forum',
        cards: [
          {
            lead: 'Charge dysregulation in EDS patients',
            body: 'The water table collapse changes charge behavior.',
            points: [],
            concepts: {},
          },
        ],
      },
    ],
  });
  const [card] = repaired.sections[0].cards;

  assert.match(card.body, /\{\{concept:water table collapse\}\}/);
  assert.match(card.concepts['water table collapse'].text, /not a literal groundwater table/);
});
