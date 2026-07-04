/**
 * eeo-strings.js — canonical EEO option strings + decline synonym bag (spec §5.6).
 * Matched by normalized-exact equality first (these are standardized across
 * Workday/Greenhouse), falling back to the shared option-matcher pipeline.
 */
(function (root) {
  'use strict';

  const DISABILITY_OPTIONS = [
    'Yes, I have a disability, or have had one in the past',
    'No, I do not have a disability and have not had one in the past',
    'I do not want to answer',
  ];

  const VETERAN_OPTIONS = [
    'I am not a protected veteran',
    'I identify as one or more of the classifications of a protected veteran',
    "I don't wish to answer",
  ];

  const RACE_ETHNICITY_OPTIONS = [
    'American Indian or Alaska Native',
    'Asian',
    'Black or African American',
    'Hispanic or Latino',
    'Native Hawaiian or Other Pacific Islander',
    'White',
    'Two or More Races',
    'Decline to self-identify',
  ];

  // Phrasing varies most on the "decline" option across ATSs; match any of
  // these tokens as equivalent regardless of exact wording.
  const DECLINE_SYNONYMS = ['decline', 'do not wish', 'prefer not', "don't wish", 'not want to answer'];

  function isDeclineOption(label) {
    const Fuzzy = root.Fuzzy || (typeof require === 'function' ? require('./fuzzy.js') : null);
    const n = Fuzzy.normalize(label);
    return DECLINE_SYNONYMS.some((s) => n.includes(Fuzzy.normalize(s)));
  }

  const EeoStrings = {
    DISABILITY_OPTIONS,
    VETERAN_OPTIONS,
    RACE_ETHNICITY_OPTIONS,
    DECLINE_SYNONYMS,
    isDeclineOption,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = EeoStrings;
  }
  root.EeoStrings = EeoStrings;
})(typeof self !== 'undefined' ? self : this);
