import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  transferCash,
  passGo,
  acquirePropertyFromBank,
  calculateRent,
  payRent,
  setBuildings,
  transferPropertyShare,
  setMortgage,
  createDeal,
  createPrimaryStockOffering,
  createSecondaryStockTrade,
  signDeal,
  rollDealApproval,
  setDealApprovalCondition,
  acceptDealCondition,
  castDealVote,
  executeDeal,
  createPolicy,
  rollPolicyApproval,
  setPolicyApprovalCondition,
  castPolicyVote,
  activatePolicy,
  createMerger,
  rollMergerApproval,
  signMerger,
  castMergerVote,
  executeMerger,
  createContract,
  createDispute,
  recordVoiceNote,
  localRuleTest,
  advanceTurn,
  calculateTaxBill,
  payTaxBill,
  collectFreeParking,
  antitrustEligibility,
  runAntitrustReview,
  completeAntitrustDivestiture,
  stockOwnershipPercent,
  getBankLendingQuote,
  updateBankLendingMarket,
  takeBankLoan,
  repayBankLoan,
  playerNetWorthBreakdown,
  roundMoney,
  SYSTEM_ENTITIES,
  undoLast,
  exportGame,
  importGame
} from "../public/engine.js";

function game() { return createGame(["Alex", "Sam", "Priya", "Jordan"], { name: "Test Game" }); }
function constant(value) { return () => value; }
function advanceRounds(state, rounds, rng = constant(0.5)) {
  let next = state;
  for (let i = 0; i < rounds * 4; i += 1) next = advanceTurn(next, rng);
  return next;
}

function approveAndSign(state, dealId, rng = constant(0.05)) {
  let next = rollDealApproval(state, dealId, rng);
  next = signDeal(next, dealId, next.deals.find(d => d.id === dealId).proposerId);
  next = signDeal(next, dealId, next.deals.find(d => d.id === dealId).counterpartyId);
  return next;
}

test("new games require exactly four player-companies", () => {
  assert.throws(() => createGame(["Alex", "Sam"]), /exactly four/i);
  const state = game();
  assert.equal(state.players.length, 4);
  assert.equal(state.market.stocks.length, 4);
  assert.equal(state.market.stocks[0].outstandingShares, 100);
  assert.equal(state.market.stocks[0].authorizedShares, 150);
});

test("cash transfers remain atomic", () => {
  const state = game();
  const paid = transferCash(state, "P1", "P2", 250, "Test payment");
  assert.equal(paid.players[0].cash, 1250);
  assert.equal(paid.players[1].cash, 1750);
  assert.throws(() => transferCash(paid, "P1", "P2", 5000), /enough cash/i);
  assert.equal(paid.players[0].cash, 1250);
});

test("passing GO pays the active company from the bank and logs the event", () => {
  const state = game();
  const playerCash = state.players[0].cash;
  const bankCash = state.bank.cash;
  const next = passGo(state, "P1");
  assert.equal(next.players[0].cash, playerCash + 200);
  assert.equal(next.bank.cash, bankCash - 200);
  assert.equal(next.ledger[0].type, "passed_go");
  assert.equal(next.ledger[0].metadata.amount, 200);
});

test("net worth breakdown exists for all four players and includes delinquent debt", () => {
  let state = game();
  state = acquirePropertyFromBank(state, "P2", "mediterranean");
  state = takeBankLoan(state, "P1", 500);
  state = advanceRounds(state, 4);
  const loan = state.loans.find(item => item.borrowerId === "P1");
  assert.equal(loan.status, "delinquent");
  const breakdowns = state.players.map(player => playerNetWorthBreakdown(state, player.id));
  assert.equal(breakdowns.length, 4);
  assert.equal(breakdowns[0].debts, loan.balance);
  assert.equal(breakdowns[1].propertyEquity, 60);
  for (const breakdown of breakdowns) {
    assert.equal(Number.isInteger(breakdown.total), true);
    assert.equal(breakdown.total, breakdown.cash + breakdown.propertyEquity + breakdown.stockInvestments + breakdown.receivables - breakdown.debts);
  }
});

test("property purchase and undo restore cash and title", () => {
  let state = game();
  state = acquirePropertyFromBank(state, "P1", "mediterranean");
  assert.equal(state.players[0].cash, 1440);
  assert.deepEqual(state.properties.find(p => p.id === "mediterranean").ownerShares, [{ entityId: "P1", percent: 100 }]);
  state = undoLast(state);
  assert.equal(state.players[0].cash, 1500);
  assert.deepEqual(state.properties.find(p => p.id === "mediterranean").ownerShares, []);
});

test("conventional rent, building, mortgage, and shared title rules remain enforced", () => {
  let state = game();
  state = acquirePropertyFromBank(state, "P1", "mediterranean");
  assert.throws(() => setBuildings(state, "mediterranean", 1), /full color set/i);
  state = acquirePropertyFromBank(state, "P1", "baltic");
  assert.equal(calculateRent(state, "mediterranean").total, 4);
  state = setBuildings(state, "mediterranean", 1);
  assert.throws(() => setBuildings(state, "mediterranean", 2), /Build evenly/i);
  state = setBuildings(state, "baltic", 1);
  assert.throws(() => setMortgage(state, "baltic", true), /Sell all buildings/i);
  assert.throws(() => transferPropertyShare(state, "baltic", "P1", "P2", 100), /Sell all buildings/i);
});

test("every formal deal pays a nonrefundable legal fee into Free Parking", () => {
  let state = game();
  state = createDeal(state, {
    title: "Rejected filing",
    proposerId: "P1",
    counterpartyId: "P2",
    proposerGives: [{ type: "cash", amount: 100 }]
  });
  const id = state.deals[0].id;
  assert.equal(state.players[0].cash, 1475);
  assert.equal(state.freeParkingPot, 25);
  state = rollDealApproval(state, id, constant(0.75));
  assert.equal(state.deals[0].approval.outcome, "rejected");
  assert.equal(state.players[0].cash, 1475);
  assert.equal(state.freeParkingPot, 25);
});

test("fixed approval system uses 10% approved, 40% conditional, and 50% rejected bands", () => {
  const make = value => {
    let state = game();
    state = createDeal(state, { title: `Band ${value}`, proposerId: "P1", counterpartyId: "P2", proposerGives: [{ type: "cash", amount: 10 }] });
    return rollDealApproval(state, state.deals[0].id, constant(value)).deals[0].approval.outcome;
  };
  assert.equal(make(0.09), "approved");
  assert.equal(make(0.10), "approved_with_conditions");
  assert.equal(make(0.49), "approved_with_conditions");
  assert.equal(make(0.50), "rejected");
});

test("ordinary deals settle only after the final approved version waits two rounds", () => {
  let state = game();
  state = createDeal(state, { title: "T plus two", proposerId: "P1", counterpartyId: "P2", proposerGives: [{ type: "cash", amount: 100 }] });
  const id = state.deals[0].id;
  state = approveAndSign(state, id);
  assert.equal(state.deals[0].settlementRound, 3);
  assert.throws(() => executeDeal(state, id), /round 3/i);
  state = advanceRounds(state, 2);
  state = executeDeal(state, id);
  assert.equal(state.players[0].cash, 1375); // 1500 - 25 legal - 100 settlement
  assert.equal(state.players[1].cash, 1600);
});

test("conditional approval requires AI condition acceptance and can add another settlement round", () => {
  let state = game();
  state = createDeal(state, { title: "Conditional", proposerId: "P1", counterpartyId: "P2", proposerGives: [{ type: "cash", amount: 20 }] });
  const id = state.deals[0].id;
  state = rollDealApproval(state, id, constant(0.25));
  state = setDealApprovalCondition(state, id, "Add one extra settlement round.", "test", { mechanic: "extra_settlement_round", value: 1 });
  state = acceptDealCondition(state, id, "P1");
  state = acceptDealCondition(state, id, "P2");
  state = signDeal(state, id, "P1");
  state = signDeal(state, id, "P2");
  assert.equal(state.deals[0].settlementRound, 4);
});

test("primary offerings raise capital, dilute voting ownership, and require a shareholder vote", () => {
  let state = game();
  state = createPrimaryStockOffering(state, { companyId: "P1", buyerId: "P2", shares: 10 });
  const id = state.deals[0].id;
  state = rollDealApproval(state, id, constant(0.05));
  state = signDeal(state, id, "P1");
  state = signDeal(state, id, "P2");
  assert.equal(state.deals[0].settlementRound, null);
  state = castDealVote(state, id, "P1", "P1", "yes");
  assert.equal(state.deals[0].settlementRound, 3);
  state = advanceRounds(state, 2);
  state = executeDeal(state, id);
  assert.equal(state.market.stocks[0].outstandingShares, 110);
  assert.equal(stockOwnershipPercent(state, "P1", "P1"), 90.91);
  assert.equal(stockOwnershipPercent(state, "P1", "P2"), 9.09);
  assert.equal(state.players[0].cash, 1575); // 1500 - 25 fee + 100 capital
  assert.equal(state.players[1].cash, 1400);
});

test("rent revenue conserves cash and pays outside shareholders a 20% dividend pool", () => {
  let state = game();
  state = createPrimaryStockOffering(state, { companyId: "P1", buyerId: "P2", shares: 50 });
  const offerId = state.deals[0].id;
  state = rollDealApproval(state, offerId, constant(0.05));
  state = signDeal(state, offerId, "P1");
  state = signDeal(state, offerId, "P2");
  state = castDealVote(state, offerId, "P1", "P1", "yes");
  state = advanceRounds(state, 2);
  state = executeDeal(state, offerId);
  state = acquirePropertyFromBank(state, "P1", "boardwalk");
  const before = state.players.reduce((sum, p) => sum + p.cash, 0) + state.freeParkingPot;
  const p1Before = state.players[0].cash;
  const p2Before = state.players[1].cash;
  state = payRent(state, "P3", "boardwalk");
  const after = state.players.reduce((sum, p) => sum + p.cash, 0) + state.freeParkingPot;
  assert.equal(after, before);
  // Base Boardwalk rent is 50. Dividend pool is 10; P2 owns 1/3 of 150 shares.
  assert.equal(state.players[1].cash - p2Before, 3);
  assert.equal(state.players[0].cash - p1Before, 47);
  assert.equal(Number.isInteger(state.players[1].cash), true);
  assert.equal(Number.isInteger(state.players[0].cash), true);
});

test("stock prices move once per completed four-player round without explanations", () => {
  let state = game();
  const sequence = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9];
  let index = 0;
  const rng = () => sequence[index++] ?? 0.9;
  state = advanceRounds(state, 1, rng);
  assert.equal(state.round, 2);
  assert.equal(state.market.stocks[0].history.length, 2);
  assert.notEqual(state.market.stocks[0].price, 10);
  assert.equal(state.ledger.some(event => event.type === "market_update"), true);
  assert.equal("reason" in state.market.stocks[0].history.at(-1), false);
});



test("all cash settlements round to whole Monopoly dollars", () => {
  let state = game();
  state = transferCash(state, "P1", "P2", 10.4, "Rounded down");
  assert.equal(state.players[0].cash, 1490);
  assert.equal(state.players[1].cash, 1510);
  state = transferCash(state, "P1", "P2", 10.6, "Rounded up");
  assert.equal(state.players[0].cash, 1479);
  assert.equal(state.players[1].cash, 1521);
  assert.equal(roundMoney(3.33), 3);
  assert.equal(roundMoney(3.67), 4);
});

test("bank lending rates rise as bank liquidity falls", () => {
  let state = game();
  const opening = getBankLendingQuote(state);
  for (const borrowerId of ["P1", "P2", "P3", "P4"]) state = takeBankLoan(state, borrowerId, 500);
  const depleted = getBankLendingQuote(state);
  assert.equal(Number.isInteger(opening.ratePercent), true);
  assert.equal(Number.isInteger(depleted.ratePercent), true);
  assert.ok(depleted.ratePercent > opening.ratePercent);
  assert.equal(depleted.cash, opening.cash - 2000);
});

test("bank rate carries bounded round-to-round randomness", () => {
  const high = updateBankLendingMarket(game(), constant(1));
  const low = updateBankLendingMarket(game(), constant(0));
  const highQuote = getBankLendingQuote(high);
  const lowQuote = getBankLendingQuote(low);
  assert.equal(highQuote.randomSpreadPercent, 3);
  assert.equal(lowQuote.randomSpreadPercent, -2);
  assert.ok(highQuote.ratePercent > lowQuote.ratePercent);
  assert.ok(Math.abs(highQuote.randomSpreadPercent) <= 3);
  assert.ok(Math.abs(lowQuote.randomSpreadPercent) <= 3);
});

test("bank loans lock a whole-percent rate and whole-dollar repayment", () => {
  let state = game();
  const quote = getBankLendingQuote(state);
  state = takeBankLoan(state, "P1", 155.4);
  const loan = state.loans[0];
  assert.equal(loan.principal, 155);
  assert.equal(loan.ratePercent, quote.ratePercent);
  assert.equal(loan.interestAmount, 12);
  assert.equal(loan.balance, 167);
  assert.equal(loan.dueRound, 4);
  assert.equal(state.players[0].cash, 1655);
  state = repayBankLoan(state, loan.id);
  assert.equal(state.players[0].cash, 1488);
  assert.equal(state.loans[0].status, "repaid");
  assert.equal(Number.isInteger(state.bank.cash), true);
});

test("emergency bank liquidity fulfills required payouts but suspends new lending", () => {
  let state = createGame(["Alex", "Sam", "Priya", "Jordan"], { bankStartingCash: 1000, bankReserveFloor: 0 });
  state = transferCash(state, SYSTEM_ENTITIES.BANK, "P1", 1500, "Required bank payout");
  let quote = getBankLendingQuote(state);
  assert.equal(state.bank.cash, 0);
  assert.equal(state.bank.emergencyCredit, 500);
  assert.equal(quote.ratePercent, 30);
  assert.equal(quote.maximumSingleLoan, 0);
  state = transferCash(state, "P1", SYSTEM_ENTITIES.BANK, 500, "Repay emergency liquidity");
  quote = getBankLendingQuote(state);
  assert.equal(state.bank.emergencyCredit, 0);
  assert.ok(quote.ratePercent < 30);
});

test("corporate policies pay legal fees, use approval, weighted voting, and delayed activation", () => {
  let state = game();
  state = createPolicy(state, { companyId: "P1", title: "Development budget", type: "development", terms: "Authorize $300 for houses." });
  const id = state.policies[0].id;
  assert.equal(state.freeParkingPot, 25);
  state = rollPolicyApproval(state, id, constant(0.05));
  state = castPolicyVote(state, id, "P1", "yes");
  assert.equal(state.policies[0].effectiveRound, 3);
  state = advanceRounds(state, 2);
  state = activatePolicy(state, id);
  assert.equal(state.policies[0].status, "active");
});

test("Tax Day creates property and net-worth bills and sends payment to Free Parking", () => {
  let state = game();
  state = acquirePropertyFromBank(state, "P1", "boardwalk");
  const preview = calculateTaxBill(state, "P1");
  assert.equal(preview.propertyTax, 10);
  state = advanceRounds(state, 4);
  assert.equal(state.round, 5);
  const bill = state.taxBills.find(item => item.playerId === "P1");
  assert.ok(bill);
  const potBefore = state.freeParkingPot;
  state = payTaxBill(state, bill.id);
  assert.equal(state.freeParkingPot, potBefore + bill.total);
});

test("Free Parking pays the complete accumulated jackpot", () => {
  let state = game();
  state = createContract(state, { title: "Fee source", partyIds: ["P1", "P2"], sponsorId: "P1", terms: "A documented promise.", status: "draft" });
  assert.equal(state.freeParkingPot, 25);
  state = collectFreeParking(state, "P3");
  assert.equal(state.freeParkingPot, 0);
  assert.equal(state.players[2].cash, 1525);
});

test("mergers pay fees, require both shareholder votes, wait two rounds, and remove the target turn", () => {
  let state = game();
  state = createMerger(state, { acquirerId: "P1", targetId: "P2", title: "A buys B" });
  const id = state.mergers[0].id;
  assert.equal(state.players[0].cash, 1275);
  assert.equal(state.freeParkingPot, 225);
  state = rollMergerApproval(state, id, constant(0.05));
  state = signMerger(state, id, "P1");
  state = signMerger(state, id, "P2");
  state = castMergerVote(state, id, "P1", "P1", "yes");
  state = castMergerVote(state, id, "P2", "P2", "yes");
  assert.equal(state.mergers[0].settlementRound, 3);
  state = advanceRounds(state, 2);
  state = executeMerger(state, id, constant(0.01));
  assert.equal(state.players[1].mergedInto, "P1");
  assert.equal(state.market.stocks[1].status, "merged");
  assert.equal(state.market.stocks[0].outstandingShares, 200);
  // Advance from P1 skips merged P2 and lands on P3.
  state.activePlayerIndex = 0;
  state = advanceTurn(state, constant(0.5));
  assert.equal(state.players[state.activePlayerIndex].id, "P3");
});


test("four railroads trigger one antitrust review and half-rent order reduces the visitor payment", () => {
  let state = game();
  for (const id of ["reading-railroad", "pennsylvania-railroad", "bo-railroad", "short-line"]) state = acquirePropertyFromBank(state, "P1", id);
  const eligibility = antitrustEligibility(state, "P1");
  assert.equal(eligibility.eligible, true);
  assert.ok(eligibility.reasons.includes("four_railroads"));
  state = runAntitrustReview(state, "P1", constant(0.45));
  assert.equal(state.antitrustReviews[0].outcome, "half_rent");
  const before = state.players.find(player => player.id === "P2").cash;
  state = payRent(state, "P2", "reading-railroad");
  assert.equal(before - state.players.find(player => player.id === "P2").cash, 100);
  assert.throws(() => runAntitrustReview(state, "P1", constant(0.01)), /already received/i);
});

test("antitrust divestiture records a table auction and pays the seller", () => {
  let state = game();
  for (const id of ["reading-railroad", "pennsylvania-railroad", "bo-railroad", "short-line"]) state = acquirePropertyFromBank(state, "P1", id);
  state = runAntitrustReview(state, "P1", constant(0.95));
  const review = state.antitrustReviews[0];
  assert.equal(review.status, "divestiture_due");
  const sellerBefore = state.players[0].cash;
  const buyerBefore = state.players[1].cash;
  state = completeAntitrustDivestiture(state, review.id, "reading-railroad", "P2", 175);
  assert.equal(state.players[0].cash, sellerBefore + 175);
  assert.equal(state.players[1].cash, buyerBefore - 175);
  assert.deepEqual(state.properties.find(property => property.id === "reading-railroad").ownerShares, [{ entityId: "P2", percent: 100 }]);
  assert.equal(state.antitrustReviews[0].status, "resolved");
});

test("local judge identifies an unsigned draft as nonbinding", () => {
  let state = game();
  state = createContract(state, { title: "Draft promise", partyIds: ["P1", "P2"], sponsorId: "P1", terms: "Alex may pay later.", status: "draft" });
  const contractId = state.contracts[0].id;
  state = createDispute(state, { title: "Draft dispute", linkedContractId: contractId, issue: "Is this draft binding?" });
  const result = localRuleTest(state, state.disputes[0].id);
  assert.equal(result.verdict, "not_binding");
  assert.ok(result.citedRuleIds.includes("R-03"));
});

test("export and import preserve market, filings, and ledger", () => {
  let state = game();
  state = createSecondaryStockTrade(state, { companyId: "P1", sellerId: "P1", buyerId: "P2", shares: 5 });
  const imported = importGame(exportGame(state));
  assert.equal(imported.market.stocks.length, 4);
  assert.equal(imported.deals[0].kind, "secondary_stock_trade");
  assert.deepEqual(imported.undoStack, []);
});

test("voice notes preserve transcript metadata and remain undoable", () => {
  const state = game();
  const noted = recordVoiceNote(state, "Speech recognition failed even though the API health check was true.", "technical_flag", "Speech recognition failure", { model: "local", confidence: 1, actorIds: [] });
  assert.equal(noted.ledger[0].metadata.voice, true);
  assert.equal(noted.ledger[0].metadata.transcript.includes("recognition failed"), true);
  assert.equal(undoLast(noted).ledger[0].type, "undo");
});

test("shared construction costs round to whole dollars without creating or losing cash", () => {
  let state = game();
  for (const id of ["mediterranean", "baltic"]) {
    state = acquirePropertyFromBank(state, "P1", id);
    state = transferPropertyShare(state, id, "P1", "P2", 33, "Joint development");
  }
  const bankBefore = state.bank.cash;
  const p1Before = state.players[0].cash;
  const p2Before = state.players[1].cash;
  state = setBuildings(state, "mediterranean", 1);
  assert.equal(state.bank.cash - bankBefore, 50);
  assert.equal(p1Before - state.players[0].cash, 34);
  assert.equal(p2Before - state.players[1].cash, 16);
  assert.equal((p1Before + p2Before) - (state.players[0].cash + state.players[1].cash), 50);
});

test("bank loan becomes delinquent only after its due round has fully passed", () => {
  let state = takeBankLoan(game(), "P1", 200);
  const dueRound = state.loans[0].dueRound;
  state = advanceRounds(state, dueRound - state.round);
  assert.equal(state.round, dueRound);
  assert.equal(state.loans[0].status, "active");
  state = advanceRounds(state, 1);
  assert.equal(state.round, dueRound + 1);
  assert.equal(state.loans[0].status, "delinquent");
  assert.ok(state.loans[0].delinquentAt);
});

test("repaying a bank loan restores liquidity and lowers the quoted base rate", () => {
  let state = game();
  state = takeBankLoan(state, "P1", 500);
  const depleted = getBankLendingQuote(state);
  state = repayBankLoan(state, state.loans[0].id);
  const restored = getBankLendingQuote(state);
  assert.ok(restored.cash > depleted.cash);
  assert.ok(restored.baseRatePercent < depleted.baseRatePercent);
});

test("legacy decimal balances and prices are rounded during import", () => {
  const legacy = JSON.parse(exportGame(game()));
  legacy.schemaVersion = 3;
  legacy.players[0].cash = 1499.6;
  legacy.freeParkingPot = 24.5;
  legacy.bank.cash = 14579.4;
  legacy.market.stocks[0].price = 10.6;
  const imported = importGame(legacy);
  assert.equal(imported.players[0].cash, 1500);
  assert.equal(imported.freeParkingPot, 25);
  assert.equal(imported.bank.cash, 14579);
  assert.equal(imported.market.stocks[0].price, 11);
  assert.equal(imported.schemaVersion, 4);
});
