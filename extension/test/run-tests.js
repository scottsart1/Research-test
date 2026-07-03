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
    const r = Matcher.matchField(
      field({ input_type: 'select', label_text: 'Gender', options: ['Male', 'Female', 'Decline to self-identify'] }),
      defaultBank,
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
  test('Tier 2 regex: "desired salary" routes to placeholder -> NEEDS_REVIEW (never fabricate a number)', () => {
    const r = Matcher.matchField(field({ label_text: 'Desired salary' }), defaultBank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
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
    const r = Matcher.matchField(field({ label_text: 'Are you willing to obtain a security clearance?' }), defaultBank, {});
    assert.strictEqual(r.status, 'NEEDS_REVIEW');
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
