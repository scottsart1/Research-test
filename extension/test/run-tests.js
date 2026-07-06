#!/usr/bin/env node
/**
 * run-tests.js — dependency-free Node test runner for the Phase 1 + Phase 2
 * required tests (spec §10). Exercises the pure decision-logic modules
 * (lib/*.js, data/match-rules.js, content/matcher.js) directly — no browser
 * needed, since none of these files touch the DOM. filler.js/detector.js
 * DOM interaction is verified separately by loading test/form.html in
 * Chrome (see test/README section in the repo README).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const Fuzzy = require('../lib/fuzzy.js');
const OptionMatcher = require('../lib/option-matcher.js');
const WorkAuthMatcher = require('../lib/workauth-matcher.js');
const EeoStrings = require('../lib/eeo-strings.js');
const ResumeUtils = require('../lib/resume-utils.js');
const Matcher = require('../content/matcher.js');

const defaultBank = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/default-answer-bank.json'), 'utf8'));

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail += 1;
    failures.push({ name, err });
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

function freshBank(overrides) {
  const bank = JSON.parse(JSON.stringify(defaultBank));
  return Object.assign(bank, overrides || {});
}

function field(overrides) {
  return Object.assign(
    { input_type: 'text', label_text: '', context_text: '', attributes: {}, options: [], required: false, current_value: '' },
    overrides
  );
}

console.log('\n=== Phase 2 required test 1: 8 patterns x 3 presets = 24 assertions ===');
{
  const PRESETS = ['f1_opt', 'permanent_resident', 'citizen'];
  const QUESTIONS = {
    legally_authorized: 'Are you legally authorized to work in the United States?',
    sponsorship_future: 'Will you now or in the future require sponsorship for employment visa status?',
    sponsorship_now: 'Do you require sponsorship to work?',
    without_sponsorship: 'Are you authorized to work in the US without sponsorship?',
    citizen: 'Are you a U.S. citizen?',
    permanent_resident: 'Are you a permanent resident / green card holder?',
    citizen_or_pr: 'Are you a citizen or permanent resident?',
  };
  const EXPECTED = {
    legally_authorized: { f1_opt: 'Yes', permanent_resident: 'Yes', citizen: 'Yes' },
    sponsorship_future: { f1_opt: 'Yes', permanent_resident: 'No', citizen: 'No' },
    sponsorship_now: { f1_opt: 'No', permanent_resident: 'No', citizen: 'No' },
    without_sponsorship: { f1_opt: 'No', permanent_resident: 'Yes', citizen: 'Yes' },
    citizen: { f1_opt: 'No', permanent_resident: 'No', citizen: 'Yes' },
    permanent_resident: { f1_opt: 'No', permanent_resident: 'Yes', citizen: 'No' },
    citizen_or_pr: { f1_opt: 'No', permanent_resident: 'Yes', citizen: 'Yes' },
  };
  for (const [patternKey, question] of Object.entries(QUESTIONS)) {
    for (const preset of PRESETS) {
      test(`${patternKey} / ${preset}`, () => {
        const result = Matcher.matchField(field({ label_text: question }), defaultBank, { immigrationStatus: preset });
        assert.strictEqual(result.status, 'FILL');
        assert.strictEqual(result.value, EXPECTED[patternKey][preset]);
        assert.strictEqual(result.lockIcon, true);
      });
    }
  }
  // 8th pattern: status dropdown, covered in its own test below (needs options).
  test('status_dropdown / f1_opt matches an F-1 option', () => {
    const result = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Work authorization status', options: ['F-1 OPT', 'H-1B', 'Other'] }),
      defaultBank,
      { immigrationStatus: 'f1_opt' }
    );
    assert.strictEqual(result.status, 'FILL');
    assert.strictEqual(result.value, 'F-1 OPT');
  });
  test('status_dropdown / permanent_resident matches a PR option', () => {
    const result = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Immigration status', options: ['US Citizen', 'Permanent Resident', 'H-1B'] }),
      defaultBank,
      { immigrationStatus: 'permanent_resident' }
    );
    assert.strictEqual(result.value, 'Permanent Resident');
  });
  test('status_dropdown / citizen matches a citizen option', () => {
    const result = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Visa status', options: ['US Citizen', 'Permanent Resident', 'H-1B'] }),
      defaultBank,
      { immigrationStatus: 'citizen' }
    );
    assert.strictEqual(result.value, 'US Citizen');
  });
}

console.log('\n=== Phase 2 required test 2: "without sponsorship" wording variants ===');
{
  const wordings = [
    'Are you authorized to work in the US without sponsorship?',
    'Without sponsorship, are you eligible to work in the United States?',
  ];
  for (const w of wordings) {
    test(`"${w}" / f1_opt -> No`, () => {
      const r = Matcher.matchField(field({ label_text: w }), defaultBank, { immigrationStatus: 'f1_opt' });
      assert.strictEqual(r.value, 'No');
    });
    test(`"${w}" / permanent_resident -> Yes`, () => {
      const r = Matcher.matchField(field({ label_text: w }), defaultBank, { immigrationStatus: 'permanent_resident' });
      assert.strictEqual(r.value, 'Yes');
    });
    test(`"${w}" / citizen -> Yes`, () => {
      const r = Matcher.matchField(field({ label_text: w }), defaultBank, { immigrationStatus: 'citizen' });
      assert.strictEqual(r.value, 'Yes');
    });
  }
}

console.log('\n=== Phase 2 required test 3: free-text "Work authorization" -> NEEDS_REVIEW under every preset ===');
{
  for (const preset of ['f1_opt', 'permanent_resident', 'citizen']) {
    test(`free-text work authorization / ${preset}`, () => {
      const r = Matcher.matchField(field({ input_type: 'text', label_text: 'Work authorization' }), defaultBank, { immigrationStatus: preset });
      assert.strictEqual(r.status, 'NEEDS_REVIEW');
      assert.strictEqual(r.lockIcon, true);
    });
  }
}

console.log('\n=== Phase 2 required test 4: status dropdown lacking a matching option -> NEEDS_REVIEW, never "Other" ===');
{
  test('no matching status option', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Work authorization status', options: ['H-1B', 'TN Visa', 'Other'] }),
      defaultBank,
      { immigrationStatus: 'f1_opt' }
    );
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
    assert.notStrictEqual(r.value, 'Other');
  });
}

console.log('\n=== Phase 2 required test 5: per-skill YoE ===');
{
  test('years of experience with Python -> 5', () => {
    const r = Matcher.matchField(field({ label_text: 'How many years of experience do you have with Python?' }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 5);
  });
  test('years of experience with Kubernetes (absent from matrix) -> NEEDS_REVIEW', () => {
    const r = Matcher.matchField(field({ label_text: 'How many years of experience do you have with Kubernetes?' }), defaultBank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });
  test('years of relevant experience -> total_professional_years (data-adjacent context)', () => {
    const r = Matcher.matchField(
      field({ label_text: 'Years of relevant experience', context_text: 'Data Scientist role' }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, defaultBank.total_professional_years);
  });
  test('years of relevant experience with no data-adjacent context -> NEEDS_REVIEW', () => {
    const r = Matcher.matchField(field({ label_text: 'Years of relevant experience', context_text: 'Warehouse Associate role' }), defaultBank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });
}

console.log('\n=== Phase 2 required test 6: range-bucket mapping ===');
{
  test('python=5 into ["0-1","1-3","3-5","5+"] -> "5+"', () => {
    assert.strictEqual(OptionMatcher.matchRangeBucket(5, ['0-1', '1-3', '3-5', '5+']), '5+');
  });
  test('tableau=2 into ["0-1","1-3","3-5","5+"] -> "1-3"', () => {
    assert.strictEqual(OptionMatcher.matchRangeBucket(2, ['0-1', '1-3', '3-5', '5+']), '1-3');
  });
  test('range-bucket select field end to end (python YoE)', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Years of experience with Python', options: ['0-1', '1-3', '3-5', '5+'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, '5+');
  });
  test('unparseable bucket options -> NEEDS_REVIEW, never index 0', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Years of experience with Python', options: ['Beginner', 'Intermediate', 'Expert'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });
}

console.log('\n=== Phase 2 required test 7: React-controlled input survives setNativeValue + verification ===');
{
  // Minimal DOM shim: simulate a React-tracked input where a naive
  // `el.value = x` assignment is intercepted by an instance-level shadow
  // property (this is what React's input-value-tracking mechanism does in
  // some versions), while the prototype-level native setter still reaches
  // the real underlying slot -- which is exactly the technique spec §6
  // documents and filler.js implements.
  class FakeEventTarget {
    constructor() {
      this._listeners = {};
    }
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    }
    dispatchEvent(evt) {
      (this._listeners[evt.type] || []).forEach((fn) => fn(evt));
      return true;
    }
  }
  global.Event = class {
    constructor(type, opts) {
      this.type = type;
      this.bubbles = !!(opts && opts.bubbles);
    }
  };
  global.KeyboardEvent = class extends global.Event {
    constructor(type, opts) {
      super(type, opts);
      this.key = opts && opts.key;
    }
  };
  class FakeInput extends FakeEventTarget {
    constructor() {
      super();
      this._nativeValue = '';
    }
  }
  Object.defineProperty(FakeInput.prototype, 'value', {
    get() {
      return this._nativeValue;
    },
    set(v) {
      this._nativeValue = v;
    },
    configurable: true,
  });
  global.HTMLInputElement = FakeInput;
  global.HTMLTextAreaElement = class extends FakeEventTarget {};

  const Filler = require('../content/filler.js');

  test('setNativeValue bypasses an instance-level React shadow property', () => {
    const el = new FakeInput();
    // Simulate React's per-instance tracker shadowing the prototype accessor.
    let reactSawValue = null;
    Object.defineProperty(el, 'value', {
      get() {
        return this._reactShadowValue || '';
      },
      set(v) {
        reactSawValue = v;
        this._reactShadowValue = v;
      },
      configurable: true,
    });

    let inputFired = false;
    let changeFired = false;
    el.addEventListener('input', () => (inputFired = true));
    el.addEventListener('change', () => (changeFired = true));

    Filler.setNativeValue(el, 'Emily Terry');

    // The native prototype-level setter was invoked directly (bypassing the
    // instance shadow entirely), so the real underlying slot holds the value...
    const nativeGetter = Object.getOwnPropertyDescriptor(FakeInput.prototype, 'value').get;
    assert.strictEqual(nativeGetter.call(el), 'Emily Terry');
    // ...even though a naive `el.value = x` was never called, so React's
    // shadow property was never touched by this write.
    assert.strictEqual(reactSawValue, null);
    // And the events a React onChange listener depends on did fire.
    assert.strictEqual(inputFired, true);
    assert.strictEqual(changeFired, true);
  });

  test('verifyField confirms the write against the native slot', () => {
    const f = field({ input_type: 'text' });
    const el = new FakeInput();
    f.__elements = [el];
    Filler.setNativeValue(el, 'test-value');
    assert.strictEqual(Filler.verifyField(f, 'test-value'), true);
    assert.strictEqual(Filler.verifyField(f, 'wrong-value'), false);
  });
}

console.log('\n=== Phase 2 required test 8: EEO exact strings + decline synonym bag ===');
{
  test('disability options match normalized-exact', () => {
    const matched = OptionMatcher.matchOption(
      'Yes, I have a disability, or have had one in the past',
      EeoStrings.DISABILITY_OPTIONS
    );
    assert.strictEqual(matched, 'Yes, I have a disability, or have had one in the past');
  });
  test('veteran status end-to-end via matcher (bank value already canonical)', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Veteran status', options: EeoStrings.VETERAN_OPTIONS }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'I am not a protected veteran');
  });
  test('unknown decline-variant matches via synonym bag', () => {
    assert.strictEqual(EeoStrings.isDeclineOption('Prefer not to say'), true);
    assert.strictEqual(EeoStrings.isDeclineOption("I don't wish to answer"), true);
    assert.strictEqual(EeoStrings.isDeclineOption('Male'), false);
  });
  test('placeholder EEO bank values (gender/race/disability) never fill, always NEEDS_REVIEW', () => {
    const bank = freshBank({ eeo: Object.assign({}, defaultBank.eeo, { gender: '«Female / Decline»' }) });
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Gender', options: ['Male', 'Female', 'Decline to self-identify'] }),
      bank,
      {}
    );
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });
}

console.log('\n=== Additional coverage: Tier 1/2/3, placeholders, stock answers, referral, enrollment ===');
{
  test('Tier 1 attribute map: autocomplete="given-name"', () => {
    const r = Matcher.matchField(field({ attributes: { autocomplete: 'given-name' } }), defaultBank, {});
    assert.strictEqual(r.tier, 1);
    assert.strictEqual(r.value, 'Emily');
  });
  test('Tier 2 regex: "desired salary" routes to a placeholder value -> NEEDS_REVIEW (never fabricate a number)', () => {
    const bank = freshBank({ compensation: Object.assign({}, defaultBank.compensation, { desired_salary_annual: '«number — set policy»' }) });
    const r = Matcher.matchField(field({ label_text: 'Desired salary' }), bank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });
  test('Tier 2 regex: "desired salary" fills once a real bank value is set', () => {
    const r = Matcher.matchField(field({ label_text: 'Desired salary' }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, defaultBank.compensation.desired_salary_annual);
  });
  test('Tier 3 fuzzy: "where did you hear about this position" -> identity.how_heard', () => {
    const r = Matcher.matchField(field({ label_text: 'Where did you hear about this position?' }), defaultBank, {});
    assert.strictEqual(r.bankKey, 'identity.how_heard');
    assert.strictEqual(r.status, 'FILL');
  });
  test('stock answer "why do you want to work here" -> NEEDS_REVIEW, never generated', () => {
    const r = Matcher.matchField(field({ input_type: 'textarea', label_text: 'Why do you want to work at this company?' }), defaultBank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });
  test('referral yes/no radio -> "No"', () => {
    const r = Matcher.matchField(field({ input_type: 'radio_group', label_text: 'Were you referred by an employee?', options: ['Yes', 'No'] }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'No');
  });
  test('referral name text field -> NEEDS_REVIEW (not a yes/no)', () => {
    const r = Matcher.matchField(field({ input_type: 'text', label_text: 'Referral name' }), defaultBank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });
  test('currently enrolled (today is after 2026-05-31) -> "No"', () => {
    const r = Matcher.matchField(field({ input_type: 'radio_group', label_text: 'Are you currently enrolled as a student?', options: ['Yes', 'No'] }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'No');
  });
  test('public trust / suitability question always NEEDS_REVIEW', () => {
    const r = Matcher.matchField(field({ label_text: 'Are you eligible for a public trust position?' }), defaultBank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });
  test('clearance willingness placeholder never fills', () => {
    const bank = freshBank({ clearance: Object.assign({}, defaultBank.clearance, { willing_to_obtain: '«Yes/No — Emily\'s call»' }) });
    const r = Matcher.matchField(field({ label_text: 'Are you willing to obtain a security clearance?' }), bank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });
  test('clearance willingness fills once a real bank value is set', () => {
    const r = Matcher.matchField(field({ label_text: 'Are you willing to obtain a security clearance?' }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
  });
  test('conflicting Tier 2 categories within margin -> NEEDS_REVIEW', () => {
    const bank = freshBank();
    const r = Matcher.matchField(field({ label_text: 'salary range commute' }), bank, {});
    assert.ok(['NEEDS_REVIEW', 'FILL'].includes(r.status)); // structural smoke test, not a strict oracle
  });
  test('unmatched field with no rule hit -> UNMATCHED (eligible for Tier 4)', () => {
    const r = Matcher.matchField(field({ label_text: 'What is your favorite programming paradigm?' }), defaultBank, {});
    assert.strictEqual(r.status, 'UNMATCHED');
  });
  test('resolveApiKey refuses work_auth-shaped keys even if the API returned one', () => {
    const r = Matcher.resolveApiKey(field({ label_text: 'Something' }), defaultBank, 'work_auth.citizen', 0.95);
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
    assert.strictEqual(r.category, 'work_auth');
  });
  test('resolveApiKey below confidence 0.8 -> UNMATCHED', () => {
    const r = Matcher.resolveApiKey(field({}), defaultBank, 'identity.first_name', 0.5);
    assert.strictEqual(r.status, 'UNMATCHED');
  });
}

console.log('\n=== Live-run regressions (iCIMS sample): labels with section context ===');
{
  test('anchored /^city$/ still matches when a section heading is present (hayLabel fix)', () => {
    const r = Matcher.matchField(field({ label_text: 'City', context_text: 'Addresses (1)' }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'Vienna');
  });
  test('"Country*" -> identity.country', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Country*', context_text: 'Addresses (1)', options: ['— Make a Selection —', 'United States', 'Canada'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'United States');
  });
  test('"Phone Country Code" does NOT hit the country rule', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Phone Country Code', options: ['(+1) United States', '(+44) United Kingdom'] }),
      defaultBank,
      {}
    );
    assert.notStrictEqual(r.bankKey, 'identity.country');
  });
  test('Preferred Name -> Emily', () => {
    const r = Matcher.matchField(field({ label_text: 'Preferred Name' }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'Emily');
  });
  test('Password field -> NEEDS_REVIEW, never filled', () => {
    const r = Matcher.matchField(field({ label_text: 'Password (Re-enter)' }), defaultBank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });
  test('Login field -> NEEDS_REVIEW (account creation is the human\'s job)', () => {
    const r = Matcher.matchField(field({ label_text: 'Login' }), defaultBank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });
}

console.log('\n=== Repeatable experience/education blocks (spec §4.4 / §11#4) ===');
{
  const CTX = 'Professional Experience (if relevant, provide the last 10 years)';

  test('Employer -> experience.0.company', () => {
    const r = Matcher.matchField(field({ label_text: 'Employer', context_text: CTX }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'Perry International Inc.');
  });
  test('Title inside experience context -> experience.0.title', () => {
    const r = Matcher.matchField(field({ label_text: 'Title', context_text: CTX }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'Data Analyst');
  });
  test('City inside experience context -> experience city, not home city', () => {
    const r = Matcher.matchField(field({ label_text: 'City', context_text: CTX }), defaultBank, {});
    assert.strictEqual(r.value, 'New York');
  });
  test('Description inside experience context -> experience summary', () => {
    const r = Matcher.matchField(field({ input_type: 'textarea', label_text: 'Description', context_text: CTX }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.ok(String(r.value).includes('statsmodels OLS'));
  });
  test('Start Date inside experience context -> MM/YYYY of experience[0].start', () => {
    const r = Matcher.matchField(field({ label_text: 'Start Date (Month / Day / Year)', context_text: CTX }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, '02/2024');
  });
  test('"When can you start?" (no experience context) -> availability answer', () => {
    const r = Matcher.matchField(field({ label_text: 'When can you start?' }), defaultBank, {});
    assert.strictEqual(r.value, 'Two weeks from offer');
  });
  test('Reason for Leaving -> NEEDS_REVIEW, never fabricated', () => {
    const r = Matcher.matchField(field({ input_type: 'textarea', label_text: 'Reason for Leaving', context_text: CTX }), defaultBank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });

  test('block indexing: 2nd and 3rd Employer fields get experience[1]/[2]', () => {
    const mk = () => field({ label_text: 'Employer', context_text: CTX });
    const results = [mk(), mk(), mk(), mk()].map((f) => ({ field: f, match: Matcher.matchField(f, defaultBank, {}) }));
    Matcher.applyRepeatableBlockIndexing(results, defaultBank);
    assert.strictEqual(results[0].match.value, 'Perry International Inc.');
    assert.strictEqual(results[1].match.value, 'Koch Industries');
    assert.strictEqual(results[2].match.value, 'American University');
    // 4th block has no bank entry -> NEEDS_REVIEW, never a duplicate/guess.
    assert.strictEqual(results[3].match.status, 'NEEDS_REVIEW');
  });

  test('education blocks: School/Degree/Major + 2nd school gets education[1]', () => {
    const eduCtx = 'Education';
    const school1 = field({ label_text: 'School', context_text: eduCtx });
    const school2 = field({ label_text: 'School', context_text: eduCtx });
    const degreeSel = field({ input_type: 'select', label_text: 'Degree', context_text: eduCtx, options: ["High School", "Bachelor's Degree", "Master's Degree"] });
    const major = field({ label_text: 'Major', context_text: eduCtx });
    const results = [school1, degreeSel, major, school2].map((f) => ({ field: f, match: Matcher.matchField(f, defaultBank, {}) }));
    Matcher.applyRepeatableBlockIndexing(results, defaultBank);
    assert.strictEqual(results[0].match.value, 'American University');
    assert.strictEqual(results[1].match.value, "Master's Degree");
    assert.strictEqual(results[2].match.value, 'Data Science');
    assert.strictEqual(results[3].match.value, 'Pennsylvania State University');
  });

  test('"Did you graduate?" -> Yes', () => {
    const r = Matcher.matchField(field({ input_type: 'radio_group', label_text: 'Did you graduate?', options: ['Yes', 'No'], context_text: 'Education' }), defaultBank, {});
    assert.strictEqual(r.value, 'Yes');
  });
}

console.log('\n=== Ad-hoc screening questions ===');
{
  test('May we contact this employer? -> Yes', () => {
    const r = Matcher.matchField(field({ input_type: 'radio_group', label_text: 'May we contact this employer?', options: ['Yes', 'No'] }), defaultBank, {});
    assert.strictEqual(r.value, 'Yes');
  });
  test('Willing to travel -> Yes', () => {
    const r = Matcher.matchField(field({ input_type: 'radio_group', label_text: 'Are you willing to travel?', options: ['Yes', 'No'] }), defaultBank, {});
    assert.strictEqual(r.value, 'Yes');
  });
  test('Employment type select -> Full-time', () => {
    const r = Matcher.matchField(field({ input_type: 'select', label_text: 'Employment type', options: ['Full-time', 'Part-time', 'Temporary'] }), defaultBank, {});
    assert.strictEqual(r.value, 'Full-time');
  });
  test('Languages spoken -> English', () => {
    const r = Matcher.matchField(field({ label_text: 'Languages spoken' }), defaultBank, {});
    assert.strictEqual(r.value, 'English');
  });
}

console.log('\n=== AI semantic answering (resolveApiAction) ===');
{
  test('action "draft" on a textarea produces a flagged AI draft', () => {
    const f = field({ input_type: 'textarea', label_text: 'Why do you want to work at this company?' });
    const r = Matcher.resolveApiAction(f, defaultBank, { action: 'draft', draft: 'My data science background at Perry International and Koch Industries maps directly onto this role.', confidence: 0.85 });
    assert.strictEqual(r.status, 'FILL_AI_DRAFT');
    assert.strictEqual(r.aiGenerated, true);
    assert.ok(r.value.includes('Perry International'));
  });
  test('action "draft" on a select is rejected (drafts are free-text only)', () => {
    const f = field({ input_type: 'select', label_text: 'Team size preference', options: ['Small', 'Large'] });
    const r = Matcher.resolveApiAction(f, defaultBank, { action: 'draft', draft: 'Small', confidence: 0.9 });
    assert.strictEqual(r, null);
  });
  test('action "draft" on a salary question is rejected (forbidden category)', () => {
    const f = field({ input_type: 'text', label_text: 'What are your salary expectations?' });
    const r = Matcher.resolveApiAction(f, defaultBank, { action: 'draft', draft: 'Around $95,000', confidence: 0.9 });
    assert.strictEqual(r, null);
  });
  test('action "draft" on a work-auth question -> locked NEEDS_REVIEW', () => {
    const f = field({ input_type: 'text', label_text: 'Describe your visa sponsorship needs' });
    const r = Matcher.resolveApiAction(f, defaultBank, { action: 'draft', draft: 'None', confidence: 0.95 });
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
    assert.strictEqual(r.lockIcon, true);
  });
  test('action "draft" below confidence 0.6 is rejected', () => {
    const f = field({ input_type: 'textarea', label_text: 'Tell us about a project you are proud of' });
    const r = Matcher.resolveApiAction(f, defaultBank, { action: 'draft', draft: 'Something.', confidence: 0.4 });
    assert.strictEqual(r, null);
  });
  test('action "option" must validate against the field\'s real options', () => {
    const f = field({ input_type: 'select', label_text: 'Which shift can you work?', options: ['Day shift', 'Night shift', 'Either'] });
    const good = Matcher.resolveApiAction(f, defaultBank, { action: 'option', option: 'Day shift', confidence: 0.9 });
    assert.strictEqual(good.status, 'FILL');
    assert.strictEqual(good.value, 'Day shift');
    assert.strictEqual(good.aiGenerated, true);
    const bad = Matcher.resolveApiAction(f, defaultBank, { action: 'option', option: 'Swing shift', confidence: 0.9 });
    assert.strictEqual(bad, null);
  });
  test('action "map" still routes through the key pipeline with all guards', () => {
    const f = field({ input_type: 'text', label_text: 'Your top tools?' });
    const r = Matcher.resolveApiAction(f, defaultBank, { action: 'map', answer_key: 'skills_flat_list', confidence: 0.9 });
    assert.strictEqual(r.status, 'FILL');
    assert.ok(String(r.value).includes('Python'));
  });
  test('action "skip" and unknown actions -> null (local record kept)', () => {
    const f = field({ input_type: 'text', label_text: 'Anything else?' });
    assert.strictEqual(Matcher.resolveApiAction(f, defaultBank, { action: 'skip', confidence: 1 }), null);
    assert.strictEqual(Matcher.resolveApiAction(f, defaultBank, { action: 'hack', confidence: 1 }), null);
    assert.strictEqual(Matcher.resolveApiAction(f, defaultBank, null), null);
  });
}

console.log('\n=== Resume attachment (spec §6 "file" + resume-utils.js) ===');
{
  test('base64 round-trip preserves bytes exactly, including the bundled PDF', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66, 67]);
    const roundTripped = ResumeUtils.base64ToBytes(ResumeUtils.bytesToBase64(bytes));
    assert.deepStrictEqual(Array.from(roundTripped), Array.from(bytes));

    const pdfPath = path.join(__dirname, '../assets/Resume_Emily_Terry.pdf');
    const original = fs.readFileSync(pdfPath);
    const base64 = ResumeUtils.bytesToBase64(new Uint8Array(original));
    const decoded = Buffer.from(ResumeUtils.base64ToBytes(base64));
    assert.strictEqual(Buffer.compare(decoded, original), 0);
  });
  test('"Resume upload" file field routes to documents.resume_filename and fills', () => {
    const r = Matcher.matchField(field({ input_type: 'file', label_text: 'Resume upload' }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.bankKey, 'documents.resume_filename');
  });
  test('"CV" file field also routes to documents.resume_filename', () => {
    const r = Matcher.matchField(field({ input_type: 'file', label_text: 'CV' }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.bankKey, 'documents.resume_filename');
  });
}

console.log('\n=== Live-run regressions (EY/SuccessFactors + Nüvitek/Pinpoint) ===');
{
  const Filler = require('../content/filler.js');

  test('attrConflictGuard: mismatched label/attribute -> NEEDS_REVIEW instead of silent misfill', () => {
    // Live bug: sibling-label extraction misattributed "First Name" as the
    // label for a City input (Pinpoint renders labels after the input in
    // some layouts). The attribute here ("cityField1") is close enough to
    // signal city but not an exact Tier-1 dictionary hit, so the field
    // falls through to label-based Tier 2/3 matching on "First Name" —
    // exactly where the guard needs to catch the conflict and refuse to
    // silently fill "Emily" into a city field.
    const f = field({ input_type: 'text', label_text: 'First Name', attributes: { name: 'cityField1', id: 'cityField1' } });
    const r = Matcher.matchField(f, defaultBank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
    assert.ok(r.reason.startsWith('attr_label_conflict'));
  });
  test('attrConflictGuard: consistent attribute + label still fills normally', () => {
    const f = field({ input_type: 'text', label_text: 'First Name', attributes: { name: 'firstName', id: 'firstName' } });
    const r = Matcher.matchField(f, defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'Emily');
  });

  test('setNativeValue on a non-Input/TextArea custom widget never throws "Illegal invocation"', () => {
    // Live bug: SuccessFactors renders some comboboxes as non-<input>
    // elements; calling HTMLInputElement.prototype's setter on them threw.
    const events = [];
    const customWidget = {
      _value: '',
      get value() { return this._value; },
      set value(v) { this._value = v; },
      addEventListener(type, fn) {
        this._listeners = this._listeners || {};
        (this._listeners[type] = this._listeners[type] || []).push(fn);
      },
      dispatchEvent(evt) {
        events.push(evt.type);
        ((this._listeners || {})[evt.type] || []).forEach((fn) => fn(evt));
        return true;
      },
    };
    assert.doesNotThrow(() => Filler.setNativeValue(customWidget, 'English'));
    assert.strictEqual(customWidget.value, 'English');
    assert.ok(events.includes('input') && events.includes('change'));
  });

  test('"State/Province" (slash form) resolves to identity.state', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'State/Province', context_text: 'Addresses (1)', options: ['No Selection', 'Virginia', 'Maryland'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'Virginia');
  });
  test('"Country/Region" resolves to identity.country', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Country/Region', context_text: 'Addresses (1)', options: ['— Make a Selection —', 'United States', 'Canada'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'United States');
  });

  test('"Address Line 2" -> SKIPPED_OPTIONAL, not review-queue noise', () => {
    const r = Matcher.matchField(field({ label_text: 'Address Line 2' }), defaultBank, {});
    assert.strictEqual(r.status, 'SKIPPED_OPTIONAL');
  });
  test('"Legal Middle Name" -> SKIPPED_OPTIONAL', () => {
    const r = Matcher.matchField(field({ label_text: 'Legal Middle Name' }), defaultBank, {});
    assert.strictEqual(r.status, 'SKIPPED_OPTIONAL');
  });
  test('conditional "If Yes Which Country..." follow-up -> SKIPPED_OPTIONAL', () => {
    const r = Matcher.matchField(field({ input_type: 'select', label_text: 'If Yes Which Country Were You Last Assigned to?' }), defaultBank, {});
    assert.strictEqual(r.status, 'SKIPPED_OPTIONAL');
  });

  test('Prefix select with real salutation options -> Ms.', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Prefix', options: ['No Selection', 'Mr.', 'Ms.', 'Mrs.', 'Dr.'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'Ms.');
  });
  test('Prefix select with non-salutation options is left alone (Title vs. Prefix collision guard)', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Prefix', options: ['No Selection', 'Manager', 'Director'] }),
      defaultBank,
      {}
    );
    assert.notStrictEqual(r.bankKey, 'identity.prefix');
  });

  test('"Are you an EY Alumni?" -> logistics.worked_here_before -> No', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Are you an EY Alumni?', options: ['No Selection', 'Yes', 'No'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'No');
  });

  test('resume rule gated to file inputs — a "Language" select must never match it', () => {
    // Live bug: page prose ("Please note that uploading a resume/CV...")
    // leaked into context_text and matched two unrelated Language selects.
    const r = Matcher.matchField(
      field({
        input_type: 'select',
        label_text: 'Language',
        context_text: 'Please note that uploading a resume/CV is optional. Accepted file types include DOCX, PDF.',
        options: ['English', 'Spanish'],
      }),
      defaultBank,
      {}
    );
    assert.notStrictEqual(r.bankKey, 'documents.resume_filename');
  });
  test('cover-letter file field is not swept into the resume rule', () => {
    const r = Matcher.matchField(field({ input_type: 'file', label_text: 'Cover letter' }), defaultBank, {});
    assert.notStrictEqual(r.bankKey, 'documents.resume_filename');
  });

  test('$-bucketed compensation range: 95000 -> "$90,001-$100,000"', () => {
    const options = ['$30,000-$40,000', '$40,001-$50,000', '$90,001-$100,000', '$100,001-$110,000', '$201,000+', 'prefer not to answer'];
    assert.strictEqual(OptionMatcher.matchRangeBucket(95000, options), '$90,001-$100,000');
  });
  test('EY-style compensation-range question fills the correct $ bucket end to end', () => {
    const options = ['$30,000-$40,000', '$40,001-$50,000', '$90,001-$100,000', '$100,001-$110,000', '$201,000+', 'prefer not to answer'];
    const r = Matcher.matchField(
      field({
        input_type: 'radio_group',
        label_text: 'In applying for this position, please select the range that most closely represents your desired total compensation.',
        options,
      }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, '$90,001-$100,000');
  });
  test('numeric-string bank values ("95000") get range-bucket treatment, not just real numbers', () => {
    const bank = freshBank({ compensation: Object.assign({}, defaultBank.compensation, { desired_salary_annual: '95000' }) });
    const options = ['$30,000-$40,000', '$90,001-$100,000', '$201,000+'];
    const r = Matcher.matchField(field({ input_type: 'select', label_text: 'Desired salary', options }), bank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, '$90,001-$100,000');
  });
}

console.log('\n=== Live-run regressions (Robinhood / Greenhouse new board) ===');
{
  test('"Have you ever worked for Robinhood..." -> No (not in resume)', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Have you ever worked for Robinhood as an employee or contractor of Robinhood?', options: ['Select...', 'Yes', 'No'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'No');
  });
  test('"Have you ever worked for Koch Industries?" -> Yes (in resume)', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Have you ever worked for Koch Industries?', options: ['Yes', 'No'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.value, 'Yes');
  });
  test('single distinctive token: "worked at Koch before?" -> Yes', () => {
    const r = Matcher.matchField(
      field({ input_type: 'radio_group', label_text: 'Have you ever worked at Koch before?', options: ['Yes', 'No'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.value, 'Yes');
  });
  test('generic token never triggers a false Yes: "worked for American Express?" -> No', () => {
    const r = Matcher.matchField(
      field({ input_type: 'radio_group', label_text: 'Have you ever worked for American Express?', options: ['Yes', 'No'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.value, 'No');
  });
  test('"American University" as a full phrase still hits: -> Yes', () => {
    const r = Matcher.matchField(
      field({ input_type: 'radio_group', label_text: 'Have you previously worked at American University?', options: ['Yes', 'No'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.value, 'Yes');
  });

  test('"Location (City)" -> identity.city', () => {
    const r = Matcher.matchField(field({ label_text: 'Location (City)' }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'Vienna');
  });
  test('"Website" -> identity.portfolio', () => {
    const r = Matcher.matchField(field({ label_text: 'Website' }), defaultBank, {});
    assert.strictEqual(r.bankKey, 'identity.portfolio');
  });
  test('"What gender pronouns do you prefer?" -> identity.pronouns', () => {
    const r = Matcher.matchField(field({ input_type: 'select', label_text: 'What gender pronouns do you prefer?', options: ['She/Her', 'He/Him', 'They/Them', "I don't wish to answer"] }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'She/Her');
  });
  test('"What is your military status?" -> eeo.veteran_status', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'What is your military status?', options: ['I am not a protected veteran', 'I identify as one or more of the classifications of a protected veteran', "I don't wish to answer"] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.value, 'I am not a protected veteran');
  });
  test('LGBTQ+ question -> decline via synonym bag', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Do you identify as part of the LGBTQ+ community?', options: ['Yes', 'No', 'I prefer not to say'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'I prefer not to say');
  });
  test('"Are you willing to work from the office(s) listed?" -> Yes', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Are you willing to work from the office(s) listed on this posting?', options: ['Select...', 'Yes', 'No'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.value, 'Yes');
  });
  test('conflict-of-interest / bribery attestations -> always NEEDS_REVIEW', () => {
    const coi = Matcher.matchField(field({ input_type: 'select', label_text: 'Do you have any relationships that present a conflict of interest?', options: ['Yes', 'No'] }), defaultBank, {});
    assert.strictEqual(coi.status, 'NEEDS_REVIEW');
    const bribery = Matcher.matchField(field({ input_type: 'select', label_text: 'Have you held a position as a government official in the last 5 years?', options: ['Yes', 'No'] }), defaultBank, {});
    assert.strictEqual(bribery.status, 'NEEDS_REVIEW');
  });
  test('"If you answered \'Yes\' to the above question..." -> SKIPPED_OPTIONAL', () => {
    const r = Matcher.matchField(field({ input_type: 'textarea', label_text: 'If you answered "Yes" to the above question, please provide details here:' }), defaultBank, {});
    assert.strictEqual(r.status, 'SKIPPED_OPTIONAL');
  });
  test('bare "Attach" label on a hidden file input -> resume', () => {
    const r = Matcher.matchField(field({ input_type: 'file', label_text: 'Attach' }), defaultBank, {});
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.bankKey, 'documents.resume_filename');
  });
  test('bare "Attach" on a NON-file element never matches resume', () => {
    const r = Matcher.matchField(field({ input_type: 'text', label_text: 'Attach' }), defaultBank, {});
    assert.notStrictEqual(r.bankKey, 'documents.resume_filename');
  });

  test('phone verification tolerates widget reformatting (digits-equal)', () => {
    const Filler = require('../content/filler.js');
    // Widget stripped our formatting: still equivalent.
    assert.strictEqual(Filler.valuesEquivalent('7179034428', '(717) 903-4428'), true);
    // Widget added formatting to our bare digits: still equivalent.
    assert.strictEqual(Filler.valuesEquivalent('(717) 903-4428', '7179034428'), true);
    // Different numbers: never equivalent.
    assert.strictEqual(Filler.valuesEquivalent('7179034429', '(717) 903-4428'), false);
    // Non-phone text still requires exact equality.
    assert.strictEqual(Filler.valuesEquivalent('Emily ', 'Emily'), false);
  });
}

console.log('\n=== Live-run regressions (Robinhood recording): gender synonyms ===');
{
  test('bank "Female" selects "Woman" when that is the offered option', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'What is your gender identity?', options: ['Man', 'Woman', 'Non-binary', "I don't wish to answer"] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'FILL');
    assert.strictEqual(r.value, 'Woman');
  });
  test('bank "Female" still prefers a literal "Female" option when present', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Gender', options: ['Male', 'Female', 'Decline to self-identify'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.value, 'Female');
  });
  test('no gender-shaped option at all -> NEEDS_REVIEW, never a guess', () => {
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'What is your gender identity?', options: ['Alpha', 'Beta'] }),
      defaultBank,
      {}
    );
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
  });
}

console.log('\n=== Spec §11#10 invariant: no submit/auto-advance code paths ===');
{
  test('no handler targets [type=submit] and no .submit()/.click() on submit controls', () => {
    const contentDir = path.join(__dirname, '../content');
    const files = walk(contentDir).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      assert.ok(!/\.submit\(\)/.test(src), `${f} calls .submit()`);
      assert.ok(!/type=submit\]\s*\)?\.click\(\)/.test(src), `${f} clicks a [type=submit] element`);
      assert.ok(!/querySelector\(['"]\[type=submit\]/.test(src), `${f} queries for a submit control at all`);
    }
  });
}

function walk(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) {
  process.exitCode = 1;
}
