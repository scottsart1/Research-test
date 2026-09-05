import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  transferCash,
  transferPropertyShare,
  acquirePropertyFromBank,
  createDeal,
  rollDealApproval,
  setDealApprovalCondition,
  acceptDealCondition,
  signDeal,
  castDealVote,
  executeDeal,
  createPrimaryStockOffering,
  createPolicy,
  createMerger,
  rollMergerApproval,
  signMerger,
  castMergerVote,
  executeMerger,
  createContract,
  createDispute,
  advanceTurn,
  undoLast,
  validateState,
  exportGame,
  importGame
} from "../public/engine.js";

function game() { return createGame(["Alex", "Sam", "Priya", "Jordan"], { name: "Regression Game" }); }
function constant(value) { return () => value; }
function advanceRounds(state, rounds, rng = constant(0.5)) {
  let next = state;
  for (let i = 0; i < rounds * 4; i += 1) next = advanceTurn(next, rng);
  return next;
}

test("importing a malformed file fails with a readable error instead of a TypeError", () => {
  assert.throws(() => importGame("{not json"), /could not be parsed/i);
  assert.throws(() => importGame({}), /exactly four player records/i);
  assert.throws(() => importGame([]), /saved game object/i);
  const noProperties = JSON.parse(exportGame(game()));
  delete noProperties.properties;
  assert.throws(() => importGame(noProperties), /property register/i);
});

test("legacy deals without signature or asset fields import and can be signed", () => {
  let state = game();
  state = createDeal(state, { title: "Old filing", proposerId: "P1", counterpartyId: "P2", proposerGives: [{ type: "cash", amount: 50 }] });
  const legacy = JSON.parse(exportGame(state));
  legacy.schemaVersion = 3;
  delete legacy.deals[0].signatures;
  delete legacy.deals[0].counterpartyGives;
  delete legacy.deals[0].extraSettlementRounds;
  delete legacy.players[0].color;
  const imported = importGame(legacy);
  assert.deepEqual(imported.deals[0].signatures, {});
  assert.deepEqual(imported.deals[0].counterpartyGives, []);
  assert.equal(imported.players[0].color, "#ef4444");
  const approved = rollDealApproval(imported, imported.deals[0].id, constant(0.05));
  assert.ok(signDeal(approved, approved.deals[0].id, "P1").deals[0].signatures.P1);
});

test("validateState is a pure check that leaves a valid state untouched", () => {
  const state = game();
  const before = JSON.stringify(state);
  assert.equal(validateState(state), true);
  assert.equal(JSON.stringify(state), before);
});

test("undo snapshots are shared by reference and never mutated by a later undo", () => {
  const a = game();
  const b = transferCash(a, "P1", "P2", 100, "First");
  const c = transferCash(b, "P1", "P2", 100, "Second");
  assert.equal(c.undoStack.length, 2);
  assert.equal(c.undoStack[0], b.undoStack[0], "earlier snapshots are reused rather than deep-cloned on every commit");
  const poppedBefore = JSON.stringify(c.undoStack.at(-1));
  const d = undoLast(c);
  assert.equal(d.players[0].cash, 1400);
  assert.equal(d.ledger[0].type, "undo");
  assert.equal(JSON.stringify(c.undoStack.at(-1)), poppedBefore, "the snapshot still held by the previous state is unchanged");
  const e = undoLast(d);
  assert.equal(e.players[0].cash, 1500);
  assert.equal(e.undoStack.length, 0);
  assert.equal(c.players[0].cash, 1300, "earlier states remain immutable");
});

test("a deal cannot be filed with property the giver does not own, and no fee is charged", () => {
  let state = acquirePropertyFromBank(game(), "P1", "boardwalk");
  state = transferPropertyShare(state, "boardwalk", "P1", "P2", 25, "Joint venture");
  const cashBefore = state.players[2].cash;
  assert.throws(() => createDeal(state, { title: "Not mine", proposerId: "P3", counterpartyId: "P1", proposerGives: [{ type: "property_share", propertyId: "boardwalk", percent: 100 }] }), /does not own 100% of Boardwalk/i);
  assert.throws(() => createDeal(state, { title: "Too much", proposerId: "P2", counterpartyId: "P3", proposerGives: [{ type: "property_share", propertyId: "boardwalk", percent: 50 }] }), /does not own 50% of Boardwalk/i);
  assert.throws(() => createDeal(state, { title: "Nothing", proposerId: "P3", counterpartyId: "P1", proposerGives: [{ type: "cash", amount: null }] }), /positive amount/i);
  assert.throws(() => createDeal(state, { title: "Ghost", proposerId: "P3", counterpartyId: "P9", proposerGives: [{ type: "cash", amount: 10 }] }), /Player not found/i);
  assert.equal(state.players[2].cash, cashBefore);
  const filed = createDeal(state, { title: "Mine", proposerId: "P2", counterpartyId: "P3", proposerGives: [{ type: "property_share", propertyId: "boardwalk", percent: 25 }] });
  assert.equal(filed.deals[0].status, "proposed");
});

test("closed deals reject signatures, votes, and condition changes", () => {
  let state = createDeal(game(), { title: "Rejected", proposerId: "P1", counterpartyId: "P2", proposerGives: [{ type: "cash", amount: 10 }] });
  const rejectedId = state.deals[0].id;
  state = rollDealApproval(state, rejectedId, constant(0.9));
  assert.throws(() => signDeal(state, rejectedId, "P1"), /rejected proposal cannot be signed/i);

  state = createPrimaryStockOffering(state, { companyId: "P1", buyerId: "P2", shares: 10 });
  const offerId = state.deals[0].id;
  assert.throws(() => castDealVote(state, offerId, "P1", "P1", "yes"), /Regulatory approval must be resolved/i);
  state = rollDealApproval(state, offerId, constant(0.05));
  state = signDeal(state, offerId, "P1");
  state = signDeal(state, offerId, "P2");
  state = castDealVote(state, offerId, "P1", "P1", "yes");
  state = advanceRounds(state, 2);
  state = executeDeal(state, offerId);
  assert.equal(state.deals.find(d => d.id === offerId).status, "executed");
  assert.throws(() => signDeal(state, offerId, "P1"), /executed proposal cannot be signed/i);
  assert.throws(() => castDealVote(state, offerId, "P1", "P1", "no"), /executed proposal cannot be voted on/i);
});

test("redefining an approval condition cancels earlier consent, votes, and the settlement clock", () => {
  let state = createDeal(game(), { title: "Conditional", proposerId: "P1", counterpartyId: "P2", proposerGives: [{ type: "cash", amount: 20 }] });
  const id = state.deals[0].id;
  state = rollDealApproval(state, id, constant(0.25));
  state = setDealApprovalCondition(state, id, "Public disclosure.", "test", { mechanic: "public_disclosure", value: null });
  state = acceptDealCondition(state, id, "P1");
  state = acceptDealCondition(state, id, "P2");
  state = signDeal(state, id, "P1");
  state = signDeal(state, id, "P2");
  assert.equal(state.deals[0].settlementRound, 3);
  state = setDealApprovalCondition(state, id, "Add one extra settlement round.", "test", { mechanic: "extra_settlement_round", value: 1 });
  const deal = state.deals[0];
  assert.deepEqual(deal.signatures, {});
  assert.deepEqual(deal.approval.conditionAcceptedBy, []);
  assert.equal(deal.settlementRound, null);
  assert.equal(deal.status, "condition_review");
  assert.throws(() => executeDeal(state, id), /accept the final deal/i);
});

test("a merger executed on the target's own turn hands play to the next company and cancels the target's pending policies", () => {
  let state = game();
  state = createPolicy(state, { companyId: "P2", title: "Target budget", terms: "Spend $100 on houses." });
  state = createMerger(state, { acquirerId: "P1", targetId: "P2", title: "A buys B" });
  const id = state.mergers[0].id;
  state = rollMergerApproval(state, id, constant(0.05));
  state = signMerger(state, id, "P1");
  state = signMerger(state, id, "P2");
  state = castMergerVote(state, id, "P1", "P1", "yes");
  state = castMergerVote(state, id, "P2", "P2", "yes");
  state = advanceRounds(state, 2);
  state = advanceTurn(state, constant(0.5));
  assert.equal(state.players[state.activePlayerIndex].id, "P2");
  state = executeMerger(state, id, constant(0.01));
  assert.equal(state.players[1].mergedInto, "P1");
  assert.equal(state.players[state.activePlayerIndex].id, "P3", "the delisted target does not keep the turn");
  assert.equal(state.policies[0].status, "cancelled");
});

test("contracts and disputes only reference real players and contracts", () => {
  const state = game();
  assert.throws(() => createContract(state, { title: "Ghost party", partyIds: ["P1", "P7"], terms: "Something." }), /Player not found/i);
  assert.throws(() => createContract(state, { title: "Ghost sponsor", partyIds: ["P1"], sponsorId: "BANKER", terms: "Something." }), /Player not found/i);
  assert.throws(() => createDispute(state, { title: "Ghost claimant", claimantId: "P0", issue: "Who?" }), /Player not found/i);
  assert.throws(() => createDispute(state, { title: "Missing contract", linkedContractId: "contract_missing", issue: "Where?" }), /Linked contract not found/i);
  assert.equal(state.freeParkingPot, 0, "no legal fee is charged for a rejected filing");
});
