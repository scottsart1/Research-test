/**
 * Prompts and response normalizers for the three AI jobs (voice interpretation, approval
 * conditions, rule judging). Shared by the browser (direct provider calls) and the local
 * server (proxy endpoints) so both paths produce identical, whitelisted results.
 */

export const VOICE_ACTION_TYPES = Object.freeze([
  "transfer_cash",
  "buy_property",
  "pay_rent",
  "create_deal",
  "sign_deal",
  "roll_deal_approval",
  "accept_deal_condition",
  "execute_deal",
  "create_contract",
  "update_contract_status",
  "create_dispute",
  "pass_go",
  "advance_turn",
  "set_mortgage",
  "set_buildings",
  "voice_note"
]);
const VOICE_ACTION_SET = new Set(VOICE_ACTION_TYPES);

export const CONDITION_MECHANICS = Object.freeze(["extra_settlement_round", "supermajority_vote", "rent_relief", "public_disclosure", "asset_lock", "none"]);
const MECHANIC_SET = new Set(CONDITION_MECHANICS);

export const clipped = (value, max = 500) => String(value ?? "").trim().slice(0, max);
const finiteOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
const boolOrNull = value => typeof value === "boolean" ? value : null;
const stringList = (value, max = 12) => Array.isArray(value) ? value.map(item => clipped(item, 180)).filter(Boolean).slice(0, max) : [];

export const VOICE_SYSTEM_PROMPT = `You are the Voice Game Clerk for Boardroom Chaos Companion, a private conventional Monopoly game with documented house rules.

Convert a spoken transcript into a conservative JSON action plan. You categorize and propose; the local deterministic game engine executes and validates. Never invent a player, property, amount, percentage, dice total, contract, deal, or intention. Use only exact IDs supplied in context. When a material field is missing or two entities could match, put the issue in unresolved and set status to needs_review. Spoken background chatter is not an instruction unless it clearly describes a game event or starts with phrases such as "log", "record", "create", "pay", "buy", "transfer", "sign", "approve", "execute", "mortgage", "build", "end turn", or "open a case".

Distinguish:
- "Sam pays Alex 200" => transfer_cash.
- "Sam landed on Boardwalk, pay rent" => pay_rent; do not guess a utility dice total.
- "Alex buys Boardwalk for 400" => buy_property.
- A player-to-player property transfer is always a create_deal filing, never an immediate action.
- "Create/propose a deal" => create_deal, not an immediate transfer.
- "We agree/promise" => create_contract unless explicitly described as a deal proposal.
- "Open a case/dispute" => create_dispute.
- "Alex passed GO" => pass_go for Alex.
- "Log/note" without enforceable terms => voice_note.

Allowed action types and fields:
transfer_cash {fromId,toId,amount,memo}
buy_property {playerId,propertyId,price|null}
pay_rent {visitorId,propertyId,diceTotal|null,discountPercent}
create_deal {title,proposerId,counterpartyId,proposerGives:[cash or property_share],counterpartyGives:[...],terms}
sign_deal {dealId,playerId}
roll_deal_approval {dealId}
accept_deal_condition {dealId,playerId}
execute_deal {dealId}
create_contract {title,type,partyIds,terms,status:draft|active,expiresRound|null}
update_contract_status {contractId,status}
create_dispute {title,linkedContractId|null,claimantId|null,respondentId|null,issue,evidence,requestedRemedy}
pass_go {playerId}
advance_turn {}
set_mortgage {propertyId,mortgaged:true|false}
set_buildings {propertyId,buildings:0..5}
voice_note {category,summary,actorIds}

Return JSON only using exactly this top-level shape:
{
  "status":"ready|needs_review|not_understood",
  "summary":"plain-language batch summary",
  "confidence":0.0,
  "actions":[{
    "type":"transfer_cash",
    "description":"plain-language action",
    "confidence":0.0,
    "requires_confirmation":true,
    "fields":{},
    "ambiguities":[],
    "source_quote":"exact relevant words"
  }],
  "unresolved":[],
  "suggested_clarification":""
}`;

export function voiceUserPrompt(transcript, context) {
  return `Interpret this transcript as JSON.\nTRANSCRIPT:\n${transcript}\n\nCURRENT GAME CONTEXT:\n${JSON.stringify(context)}`;
}

export const APPROVAL_SYSTEM_PROMPT = `You are the regulatory approval clerk for a private four-player Monopoly house-rule game.
The proposal has already landed in the 40% "approved with conditions" band. Write exactly one concise, measurable in-game condition.
The condition must be understandable to a lay player, possible to track in the ledger, and must not secretly replace the whole bargain. Choose one of these mechanics only: extra_settlement_round, supermajority_vote, rent_relief, public_disclosure, asset_lock, or none. Do not invent real-world law. Do not add more than one condition.
Return JSON only: {"condition":"one enforceable sentence","mechanic":"one allowed mechanic","value":1}. Use value 1 for an extra round, 60 for a supermajority, and null for other mechanics.`;

export function approvalUserPrompt(kind, record, context = {}) {
  return `KIND: ${clipped(kind, 40)}\nPROPOSAL: ${JSON.stringify(record)}\nCOMPACT GAME CONTEXT: ${JSON.stringify(context)}`;
}

export const JUDGE_SYSTEM_PROMPT = `You are the Rule Test Judge for a private tabletop game called Boardroom Chaos Companion.

Your authority is limited to the supplied rulebook, signed contracts, current game state, and ledger evidence. Apply this hierarchy: (1) explicit house rule, (2) exact signed contract term, (3) conventional Monopoly baseline, (4) narrow interpretation that changes the fewest recorded rights. Never invent a new rule. Never enforce a secret or unrecorded promise. Never transfer assets when material facts are missing. If confidence is below 0.70 or the evidence does not establish a required fact, use verdict "insufficient_evidence" and recommend a neutral vote or fact-finding step.

Return JSON only. Do not reveal hidden chain-of-thought. Provide a concise reasoning summary suitable for an audit record. Use exactly this schema:
{
  "verdict": "snake_case_result",
  "confidence": 0.0,
  "cited_rule_ids": ["R-03"],
  "findings": ["Short factual finding"],
  "orders": ["Concrete in-game remedy or next step"],
  "reasoning_summary": "Concise explanation, not private chain-of-thought",
  "ambiguities": ["Missing or disputed fact"],
  "suggested_vote": "How neutral players should resolve any remaining issue"
}`;

export function judgeUserPrompt(packet) {
  return `Decide this case from the following JSON evidence packet:\n${JSON.stringify(packet)}`;
}

export const CONNECTION_TEST_SYSTEM_PROMPT = "You are a connectivity probe. Reply with JSON only.";
export const CONNECTION_TEST_USER_PROMPT = 'Return exactly {"ok":true,"greeting":"one short friendly sentence"} as JSON.';

function normalizeVoiceAsset(raw = {}) {
  const type = clipped(raw.type, 40);
  if (type === "cash") return { type, amount: finiteOrNull(raw.amount) };
  if (type === "property_share") return { type, propertyId: clipped(raw.propertyId, 100), percent: finiteOrNull(raw.percent) ?? 100 };
  if (type === "jail_card") return { type, quantity: finiteOrNull(raw.quantity) ?? 1 };
  return null;
}

function normalizeVoiceFields(type, raw = {}) {
  const assets = value => Array.isArray(value) ? value.map(normalizeVoiceAsset).filter(Boolean).slice(0, 8) : [];
  switch (type) {
    case "transfer_cash": return { fromId: clipped(raw.fromId, 100), toId: clipped(raw.toId, 100), amount: finiteOrNull(raw.amount), memo: clipped(raw.memo, 180) };
    case "buy_property": return { playerId: clipped(raw.playerId, 100), propertyId: clipped(raw.propertyId, 100), price: finiteOrNull(raw.price) };
    case "pay_rent": return { visitorId: clipped(raw.visitorId, 100), propertyId: clipped(raw.propertyId, 100), diceTotal: finiteOrNull(raw.diceTotal), discountPercent: finiteOrNull(raw.discountPercent) ?? 0 };
    case "create_deal": return {
      title: clipped(raw.title, 100), proposerId: clipped(raw.proposerId, 100), counterpartyId: clipped(raw.counterpartyId, 100),
      proposerGives: assets(raw.proposerGives), counterpartyGives: assets(raw.counterpartyGives), terms: clipped(raw.terms, 3000)
    };
    case "sign_deal": return { dealId: clipped(raw.dealId, 100), playerId: clipped(raw.playerId, 100) };
    case "roll_deal_approval": return { dealId: clipped(raw.dealId, 100) };
    case "accept_deal_condition": return { dealId: clipped(raw.dealId, 100), playerId: clipped(raw.playerId, 100) };
    case "execute_deal": return { dealId: clipped(raw.dealId, 100) };
    case "create_contract": return {
      title: clipped(raw.title, 120), type: clipped(raw.type || "custom", 40), partyIds: stringList(raw.partyIds, 8),
      terms: clipped(raw.terms, 4000), status: clipped(raw.status || "draft", 30), expiresRound: finiteOrNull(raw.expiresRound)
    };
    case "update_contract_status": return { contractId: clipped(raw.contractId, 100), status: clipped(raw.status, 30) };
    case "create_dispute": return {
      title: clipped(raw.title, 120), linkedContractId: clipped(raw.linkedContractId, 100), claimantId: clipped(raw.claimantId, 100), respondentId: clipped(raw.respondentId, 100),
      issue: clipped(raw.issue, 3000), evidence: clipped(raw.evidence, 3000), requestedRemedy: clipped(raw.requestedRemedy, 1000)
    };
    case "pass_go": return { playerId: clipped(raw.playerId, 100) };
    case "advance_turn": return {};
    case "set_mortgage": return { propertyId: clipped(raw.propertyId, 100), mortgaged: boolOrNull(raw.mortgaged) };
    case "set_buildings": return { propertyId: clipped(raw.propertyId, 100), buildings: finiteOrNull(raw.buildings) };
    case "voice_note": return { category: clipped(raw.category || "note", 40), summary: clipped(raw.summary, 500), actorIds: stringList(raw.actorIds, 8) };
    default: return {};
  }
}

/** Whitelist and clip a model-produced voice plan so only known actions with known fields survive. */
export function normalizeVoicePlan(raw = {}) {
  const actions = Array.isArray(raw.actions) ? raw.actions : [];
  const normalizedActions = actions.slice(0, 8).map(action => {
    const type = clipped(action?.type, 60);
    if (!VOICE_ACTION_SET.has(type)) return null;
    return {
      type,
      description: clipped(action.description || type.replaceAll("_", " "), 300),
      confidence: Math.max(0, Math.min(1, Number(action.confidence ?? raw.confidence ?? 0))),
      requiresConfirmation: action.requires_confirmation !== false || type !== "voice_note",
      fields: normalizeVoiceFields(type, action.fields || {}),
      ambiguities: stringList(action.ambiguities, 8),
      sourceQuote: clipped(action.source_quote, 500)
    };
  }).filter(Boolean);
  const allowedStatuses = new Set(["ready", "needs_review", "not_understood"]);
  const unresolved = stringList(raw.unresolved, 12);
  const status = allowedStatuses.has(raw.status) ? raw.status : (normalizedActions.length && !unresolved.length ? "ready" : "needs_review");
  return {
    status,
    summary: clipped(raw.summary || (normalizedActions.length ? `${normalizedActions.length} action(s) interpreted` : "No action interpreted"), 500),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0))),
    actions: normalizedActions,
    unresolved,
    suggestedClarification: clipped(raw.suggested_clarification, 500)
  };
}

/** One whitelisted, mechanically limited approval condition. */
export function normalizeCondition(raw = {}) {
  const condition = clipped(raw.condition, 600);
  if (!condition) throw new Error("The AI did not provide a usable approval condition.");
  const mechanic = MECHANIC_SET.has(raw.mechanic) ? raw.mechanic : "none";
  const value = Number.isFinite(Number(raw.value)) ? Number(raw.value) : null;
  return { condition, mechanic, value };
}

export function normalizeJudgement(raw = {}) {
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence ?? 0)));
  return {
    verdict: String(raw.verdict || "insufficient_evidence").slice(0, 120),
    confidence,
    citedRuleIds: Array.isArray(raw.cited_rule_ids) ? raw.cited_rule_ids.map(String).slice(0, 12) : [],
    findings: Array.isArray(raw.findings) ? raw.findings.map(String).slice(0, 12) : [],
    orders: Array.isArray(raw.orders) ? raw.orders.map(String).slice(0, 10) : [],
    explanation: String(raw.reasoning_summary || raw.explanation || "").slice(0, 5000),
    ambiguities: Array.isArray(raw.ambiguities) ? raw.ambiguities.map(String).slice(0, 10) : [],
    suggestedVote: String(raw.suggested_vote || "").slice(0, 500)
  };
}
