/**
 * match-rules.js — static rule tables for the matcher (spec §5).
 * Plain script, no build step: exposes self.MatchRules / module.exports.
 *
 * Bank keys are dot-paths resolved against the answer bank object by
 * matcher.js's getByPath(), e.g. "identity.first_name", "education[0].gpa",
 * "skills_yoe.python".
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // Tier 1 — attribute exact map (name / id / autocomplete -> bank key).
  // Matched against normalized attribute VALUES (not attribute names).
  // ~40 entries per spec §5 Tier 1.
  // ---------------------------------------------------------------------
  const TIER1_ATTRIBUTE_MAP = {
    'given-name': 'identity.first_name',
    'first-name': 'identity.first_name',
    firstname: 'identity.first_name',
    fname: 'identity.first_name',
    'family-name': 'identity.last_name',
    'last-name': 'identity.last_name',
    lastname: 'identity.last_name',
    lname: 'identity.last_name',
    surname: 'identity.last_name',
    name: 'identity.full_name',
    fullname: 'identity.full_name',
    'full-name': 'identity.full_name',
    email: 'identity.email',
    'email-address': 'identity.email',
    tel: 'identity.phone_formatted',
    telephone: 'identity.phone_formatted',
    phone: 'identity.phone_formatted',
    'phone-number': 'identity.phone_formatted',
    mobile: 'identity.phone_formatted',
    'postal-code': 'identity.zip',
    zip: 'identity.zip',
    zipcode: 'identity.zip',
    'address-line1': 'identity.address_line1',
    address1: 'identity.address_line1',
    street: 'identity.address_line1',
    'address-level2': 'identity.city',
    city: 'identity.city',
    'address-level1': 'identity.state',
    state: 'identity.state',
    region: 'identity.state',
    'country-name': 'identity.country',
    country: 'identity.country',
    'organization-title': 'experience.0.title',
    'current-title': 'experience.0.title',
    jobtitle: 'experience.0.title',
    linkedin: 'identity.linkedin',
    'linkedin-url': 'identity.linkedin',
    portfolio: 'identity.portfolio',
    website: 'identity.portfolio',
    github: 'identity.github',
    'url-github': 'identity.github',
    school: 'education.0.school',
    university: 'education.0.school',
    degree: 'education.0.degree',
    major: 'education.0.field',
    gpa: 'education.0.gpa',
    'preferred-name': 'identity.preferred_name',
    nickname: 'identity.preferred_name',
    pronouns: 'identity.pronouns',
  };

  // ---------------------------------------------------------------------
  // Tier 2 — ordered regex category rules (specific -> general).
  // Each rule: { key: <static bank path> } OR { resolve(hay, field) => path|null }
  // for dynamic keys (per-skill YoE, salary split fields, etc).
  // Rules with `category: 'work_auth'` are never used here — work-auth is
  // handled entirely by workauth-matcher.js and is excluded from Tier 2/3/4.
  // ---------------------------------------------------------------------

  const SKILL_ALIASES = [
    ['python', 'skills_yoe.python'],
    ['sql', 'skills_yoe.sql'],
    ['power ?bi', 'skills_yoe.power_bi'],
    ['tableau', 'skills_yoe.tableau'],
    ['r ?shiny', 'skills_yoe.r_shiny'],
    ['machine learning', 'skills_yoe.machine_learning'],
    ['deep learning', 'skills_yoe.deep_learning'],
    ['nlp|natural language processing', 'skills_yoe.nlp'],
    ['pytorch', 'skills_yoe.pytorch'],
    ['tensorflow', 'skills_yoe.tensorflow'],
    ['scikit-?learn|sklearn', 'skills_yoe.scikit-learn'],
    ['pandas', 'skills_yoe.pandas'],
    ['statsmodels', 'skills_yoe.statsmodels'],
    ['snowflake', 'skills_yoe.snowflake'],
    ['docker', 'skills_yoe.docker'],
    ['git\\b', 'skills_yoe.git'],
    ['etl', 'skills_yoe.etl'],
    ['data visuali[sz]ation', 'skills_yoe.data_visualization'],
    ['statistics', 'skills_yoe.statistics'],
    ['\\br\\b', 'skills_yoe.r'],
    ['aws|amazon web services', 'skills_yoe.aws'],
    ['spark', 'skills_yoe.spark'],
    ['excel', 'skills_yoe.excel'],
  ];
  const SKILL_ALIAS_RE = SKILL_ALIASES.map(([frag, key]) => ({ re: new RegExp(frag), key }));
  const DATA_ADJACENT_RE = /data|analy|scien|machine learning|\bml\b|engineer/;

  // Section-heading signal that a field sits inside a repeatable
  // work-history block (iCIMS "Professional Experience", Workday "Work
  // Experience", etc.) rather than the identity/contact section. resolve()
  // callbacks receive label+context, so this can gate on the heading.
  const EXPERIENCE_CONTEXT_RE = /(professional|work|employment) (experience|history)|employment record|previous employer/;
  const EDUCATION_CONTEXT_RE = /education|academic|school history/;

  const TIER2_RULES = [
    // --- Account creation / credentials: never autofill, always flag.
    // iCIMS candidate-profile pages open with a "Create a login" section;
    // passwords are the human's to invent and the login choice is theirs. ---
    { name: 'password', test: /password/, special: 'always_review' },
    { name: 'login_username', test: /^log[- ]?in\b|^username/, special: 'always_review' },

    // --- Per-skill years-of-experience (§4.5) ---
    {
      name: 'skill_yoe',
      // labelOnly: section headings like "Professional Experience (last 10
      // years)" contain both tokens and must not trip this rule for every
      // field in the block; a real YoE question carries them in its label.
      labelOnly: true,
      test: /years?.{0,25}(experience|work(ing)?).{0,25}(with|in|using)?/,
      resolve(hay) {
        for (const { re, key } of SKILL_ALIAS_RE) {
          if (re.test(hay)) return key;
        }
        if (/years?.{0,20}(relevant|professional|total|industry) experience/.test(hay)) {
          // Data-adjacent -> total_professional_years; otherwise force
          // NEEDS_REVIEW via a bank path that can never resolve, rather
          // than falling through to Tier 3/4 and risking a guess (§4.5).
          return DATA_ADJACENT_RE.test(hay) ? 'total_professional_years' : '__NEEDS_REVIEW__';
        }
        // Matched the general "years of experience [with/in/using] ..."
        // shape but named no skill we track -> never guess (§4.5 builder rule).
        return '__NEEDS_REVIEW__';
      },
    },

    // --- Clearance & federal (DC corpus, §4.6) ---
    { name: 'clearance_hold', test: /security clearance.{0,30}(hold|have|active|current)|(hold|have|active|current).{0,30}security clearance/, key: 'clearance.has_clearance' },
    { name: 'clearance_level', test: /clearance level/, key: 'clearance.clearance_level' },
    { name: 'clearance_willing', test: /(willing|able|eligib).{0,30}(obtain|receive).{0,20}clearance/, key: 'clearance.willing_to_obtain' },
    { name: 'clearance_past', test: /(held|previously).{0,20}clearance/, key: 'clearance.held_clearance_past' },
    { name: 'public_trust', test: /(public trust|suitability)/, special: 'always_review' },
    { name: 'fed_current', test: /current(ly)?.{0,20}federal (employee|government)/, key: 'federal.current_federal_employee' },
    { name: 'fed_former', test: /former.{0,20}federal (employee|government)/, key: 'federal.former_federal_employee' },
    { name: 'fed_special_hiring', test: /(schedule a|special hiring authority|non-?competitive (eligibility|appointment))/, key: 'federal.special_hiring_authority' },

    // --- Salary variants ---
    { name: 'salary_range_split', test: /compensation range|salary range/, key: 'compensation.salary_answer_text' },
    { name: 'salary_desired', test: /^(desired|expected|target|minimum) (salary|compensation|pay|base|rate)/, key: 'compensation.desired_salary_annual' },
    { name: 'salary_expectation', test: /salary (expectation|requirement)s?/, key: 'compensation.salary_answer_text' },

    // --- Repeatable experience blocks (spec §4.4; block N handled by
    // Matcher.applyRepeatableBlockIndexing over these index-0 keys) ---
    { name: 'employer', test: /^employer\b|company name|name of (the )?(company|employer)/, key: 'experience.0.company' },
    {
      name: 'experience_title',
      test: /^(job )?title$|position title/,
      resolve(hay) {
        return EXPERIENCE_CONTEXT_RE.test(hay) ? 'experience.0.title' : null;
      },
    },
    {
      name: 'experience_description',
      test: /^description$|job duties|responsibilities/,
      resolve(hay) {
        return EXPERIENCE_CONTEXT_RE.test(hay) ? 'experience.0.summary' : null;
      },
    },
    { name: 'reason_for_leaving', test: /reason for leaving/, special: 'always_review' },
    {
      name: 'block_end_date',
      test: /end date/,
      resolve(hay) {
        if (EXPERIENCE_CONTEXT_RE.test(hay)) return 'experience.0.end';
        if (EDUCATION_CONTEXT_RE.test(hay)) return 'education.0.end';
        return null;
      },
    },

    // --- Start date variants (experience/education block start dates take
    // the block key; anything else is the availability question) ---
    {
      name: 'start_date',
      test: /(earliest|available|preferred).{0,20}start|start date|when.{0,15}(start|begin|available)|notice period/,
      resolve(hay) {
        if (EXPERIENCE_CONTEXT_RE.test(hay)) return 'experience.0.start';
        if (EDUCATION_CONTEXT_RE.test(hay)) return 'education.0.start';
        return 'logistics.available_start';
      },
    },

    // --- Repeatable education blocks (spec §4.2; same block-indexing
    // mechanism as experience) ---
    { name: 'school', test: /(name of )?(school|university|college|institution)( name)?$/, key: 'education.0.school' },
    {
      name: 'degree',
      test: /^degree$|degree (earned|obtained|type|level)|level of degree/,
      resolve(hay, field) {
        // Selects list standardized levels ("Master's Degree"); free text
        // wants the actual degree name ("Master of Science").
        const hasOptions = field && field.options && field.options.length > 0;
        return hasOptions ? 'education.0.degree_level' : 'education.0.degree';
      },
    },
    { name: 'major', test: /^major$|field of study|area of study|concentration|course of study/, key: 'education.0.field' },
    { name: 'did_graduate', test: /did you (graduate|complete|obtain|earn)|degree (completed|awarded|conferred)/, key: '__literal:Yes' },

    // --- Location variants ---
    { name: 'relocate', test: /(willing|open).{0,20}relocat|relocation/, key: 'logistics.willing_to_relocate' },
    { name: 'work_setting', test: /(authorized|able).{0,15}work (on.?site|in office|hybrid)|remote.{0,10}(hybrid|onsite|in.?office)|work (arrangement|location) preference/, key: 'logistics.remote_hybrid_onsite' },
    { name: 'commute', test: /commut/, key: 'logistics.commutable_note' },
    { name: 'current_location', test: /current(ly)?.{0,15}(located|residing|live)/, key: 'identity.city' },

    // --- Education variants ---
    { name: 'highest_education', test: /highest (level of )?education/, key: 'highest_education' },
    { name: 'currently_enrolled', test: /(currently|still).{0,15}(enrolled|student)/, special: 'enrolled_date_guard' },
    { name: 'gpa', test: /\bgpa\b|grade point/, key: 'education.0.gpa' },
    { name: 'graduation_date', test: /graduation (date|year|month)/, key: 'education.0.end' },

    // --- Referral / source ---
    // Word boundaries required: "referred" is a substring of "Preferred
    // Name", which must never route here.
    { name: 'referral_yesno', test: /\b(referred|referral)\b|employee referr/, special: 'referral' },
    { name: 'how_heard', test: /how did you (hear|find|learn)/, key: 'identity.how_heard' },

    // --- Identity basics ---
    { name: 'first_name', test: /first name|given name/, key: 'identity.first_name' },
    { name: 'last_name', test: /last name|family name|surname/, key: 'identity.last_name' },
    { name: 'full_name', test: /^full name$|^name$|legal name/, key: 'identity.full_name' },
    { name: 'email', test: /e-?mail/, key: 'identity.email' },
    { name: 'phone', test: /phone|mobile number|telephone/, key: 'identity.phone_formatted' },
    { name: 'linkedin', test: /linkedin/, key: 'identity.linkedin' },
    { name: 'portfolio', test: /portfolio|personal website/, key: 'identity.portfolio' },
    { name: 'github', test: /github/, key: 'identity.github' },
    { name: 'address', test: /street address|address line ?1|^address 1$|^address$/, key: 'identity.address_line1' },
    {
      name: 'city',
      test: /^city$|town/,
      resolve(hay) {
        return EXPERIENCE_CONTEXT_RE.test(hay) ? 'experience.0.location_city' : 'identity.city';
      },
    },
    {
      name: 'state',
      test: /^state$|state\/province|state\s*\/\s*province/,
      resolve(hay) {
        return EXPERIENCE_CONTEXT_RE.test(hay) ? 'experience.0.location_state' : 'identity.state';
      },
    },
    { name: 'zip', test: /zip ?(\/? ?postal )?code|postal code/, key: 'identity.zip' },
    {
      name: 'country',
      test: /^country$|country of residence/,
      resolve(hay) {
        // "Phone Country Code" must not land here; the phone rule owns it.
        if (/phone|dial|calling code/.test(hay)) return null;
        return EXPERIENCE_CONTEXT_RE.test(hay) ? 'experience.0.country' : 'identity.country';
      },
    },
    { name: 'preferred_name', test: /preferred (first )?name|nickname|name you go by/, key: 'identity.preferred_name' },

    // --- Skills / certs ---
    { name: 'skills_list', test: /(list|summar).{0,20}(your )?(technical )?skills|key skills/, key: 'skills_flat_list' },
    { name: 'certifications', test: /certifications?/, key: 'certifications' },

    // --- Resume/CV upload (routes the field to FILL; filler.js's file()
    // strategy ignores this string value and attaches the actual stored
    // bytes instead — see spec §6 "file" + resume-utils.js) ---
    { name: 'resume_upload', test: /r[ée]sum[ée]|^cv$|curriculum vitae|upload.{0,15}resume|attach.{0,15}resume/, key: 'documents.resume_filename' },

    // --- Common ad-hoc screening questions ---
    { name: 'may_contact_employer', test: /may we contact (this|your|the) (former |previous |current )?employer/, key: '__literal:Yes' },
    { name: 'willing_travel', test: /(willing|able|available).{0,15}travel|travel (requirement|percentage|up to)/, key: 'logistics.willing_to_travel' },
    { name: 'employment_type', test: /employment type|full[- ]?time or part[- ]?time|(seeking|looking for).{0,20}(full|part)[- ]?time/, key: 'logistics.employment_type' },
    { name: 'available_full_time', test: /(available|able).{0,20}(to )?work full[- ]?time/, key: '__literal:Yes' },
    { name: 'languages_spoken', test: /languages? (spoken|you speak)|language proficiency|fluent in/, key: 'logistics.languages' },

    // --- Consents / logistics booleans ---
    { name: 'over_18', test: /(are you )?(at least )?18 years/, key: 'logistics.over_18' },
    { name: 'worked_here_before', test: /(previously|ever) (worked|employed) (here|at|for) (this company|us)/, key: 'logistics.worked_here_before' },
    { name: 'relatives', test: /(relative|family member).{0,20}(work|employ)/, key: 'logistics.relatives_at_company' },
    { name: 'non_compete', test: /non-?compete/, key: 'logistics.non_compete' },
    { name: 'background_check', test: /background check/, key: 'logistics.background_check_consent' },
    { name: 'drug_test', test: /drug (test|screen)/, key: 'logistics.drug_test_consent' },
    { name: 'criminal_record', test: /(criminal (record|history|conviction)|convicted of a (felony|crime))/, key: 'logistics.criminal_record' },
    { name: 'veteran_service', test: /military (service|veteran)|are you a veteran/, key: 'logistics.military_veteran_service' },

    // --- EEO (exact-string matched separately in option-matcher; these just route the key) ---
    { name: 'eeo_gender', test: /^gender$|gender identity/, key: 'eeo.gender' },
    { name: 'eeo_race', test: /race\/?ethnicity|race or ethnicity|^race$|^ethnicity$/, key: 'eeo.race_ethnicity' },
    { name: 'eeo_hispanic', test: /hispanic or latino/, key: 'eeo.hispanic_latino' },
    { name: 'eeo_veteran', test: /veteran status|protected veteran/, key: 'eeo.veteran_status' },
    { name: 'eeo_disability', test: /disability status|do you have a disability/, key: 'eeo.disability_status' },

    // --- Stock free-text (always NEEDS_REVIEW per bank) ---
    { name: 'why_company', test: /why (do you want to work|are you interested in working).{0,20}(at|for)|why this company/, key: 'stock_answers.why_this_company.mode' },
    { name: 'why_role', test: /why (are you interested in|do you want) this (role|position|job)/, key: 'stock_answers.why_this_role.mode' },
    { name: 'anything_else', test: /anything else|additional (information|comments)/, key: 'stock_answers.anything_else' },
  ];

  // ---------------------------------------------------------------------
  // Tier 3 — fuzzy synonym bags (3-8 phrasings each) for keys not reliably
  // caught by Tier 1/2 regexes. Token-Jaccard scored against label+context.
  // ---------------------------------------------------------------------
  const TIER3_SYNONYM_BAGS = {
    'identity.first_name': ['first name', 'given name', 'legal first name', 'preferred first name'],
    'identity.last_name': ['last name', 'family name', 'surname', 'legal last name'],
    'identity.full_name': ['full legal name', 'your name', 'applicant name'],
    'identity.email': ['email address', 'contact email', 'e mail'],
    'identity.phone_formatted': ['phone number', 'contact number', 'best phone number', 'mobile phone'],
    'identity.linkedin': ['linkedin profile', 'linkedin url', 'link to linkedin'],
    'identity.portfolio': ['portfolio link', 'personal site', 'work samples url'],
    'highest_education': ['highest degree earned', 'highest level of education completed', 'education level'],
    'compensation.salary_answer_text': ['pay expectations', 'compensation expectations', 'what are your salary requirements'],
    'logistics.available_start': ['when can you start', 'earliest available start date', 'notice period required'],
    'logistics.willing_to_relocate': ['open to relocation', 'able to relocate for this role'],
    'logistics.remote_hybrid_onsite': ['work location preference', 'remote or in office preference'],
    'clearance.has_clearance': ['do you currently hold an active clearance', 'active security clearance'],
    'federal.current_federal_employee': ['are you a current employee of the federal government'],
    'skills_flat_list': ['technical skill set', 'primary tools and languages'],
    'identity.how_heard': ['where did you hear about this position', 'source of application'],
  };

  const MatchRules = {
    TIER1_ATTRIBUTE_MAP,
    TIER2_RULES,
    TIER3_SYNONYM_BAGS,
    SKILL_ALIASES,
    DATA_ADJACENT_RE,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MatchRules;
  }
  root.MatchRules = MatchRules;
})(typeof self !== 'undefined' ? self : this);
