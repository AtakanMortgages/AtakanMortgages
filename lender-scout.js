// Lender Scout matching engine.
// Runs a client file's facts through the same region / LTV / credit /
// CP-BK seasoning / income-doc / condition screen described in the
// ontario-lender-screening skill, against LENDER_DATA (lenders-data.js).

const STATUS = { PASS: "pass", FAIL: "fail", UNCONFIRMED: "unconfirmed", NA: "na" };

function norm(s) {
  return (s || "").toLowerCase().trim();
}

function checkRegion(lender, inputRegion) {
  const region = norm(inputRegion);
  if (!region) return { status: STATUS.NA, note: "No region entered." };

  const excluded = (lender.excludedRegions || []).find(
    (r) => region.includes(r) || r.includes(region)
  );
  if (excluded) {
    return { status: STATUS.FAIL, note: `Explicitly excludes this area ("${excluded}").` };
  }

  const matched = (lender.regionTags || []).find(
    (r) => region.includes(r) || r.includes(region)
  );
  if (matched) {
    return { status: STATUS.PASS, note: `Confirmed coverage match ("${matched}").` };
  }

  return {
    status: STATUS.UNCONFIRMED,
    note: "No confirmed coverage for this specific area — verify directly before submitting.",
  };
}

function checkLTV(lender, requestedLTV) {
  if (requestedLTV == null || Number.isNaN(requestedLTV)) {
    return { status: STATUS.NA, note: "No LTV entered." };
  }
  if (lender.ltvCap == null) {
    return { status: STATUS.UNCONFIRMED, note: "No LTV cap published — request directly." };
  }
  if (requestedLTV <= lender.ltvCap) {
    return { status: STATUS.PASS, note: `Requested ${requestedLTV}% is within the ${lender.ltvCap}% cap.` };
  }
  return { status: STATUS.FAIL, note: `Requested ${requestedLTV}% exceeds the ${lender.ltvCap}% cap.` };
}

function checkCredit(lender, creditScore) {
  if (creditScore == null || Number.isNaN(creditScore)) {
    return { status: STATUS.NA, note: "No credit score entered." };
  }
  if (lender.creditFloor == null) {
    return { status: STATUS.UNCONFIRMED, note: "No credit floor published — treat as equity-based unless told otherwise." };
  }
  if (creditScore >= lender.creditFloor) {
    return { status: STATUS.PASS, note: `Clears the ~${lender.creditFloor} floor.` };
  }
  return { status: STATUS.FAIL, note: `Below the ~${lender.creditFloor} floor.` };
}

function checkCpBk(lender, cpStatus, monthsSinceDischarge) {
  if (!cpStatus || cpStatus === "none") {
    return { status: STATUS.NA, note: "No consumer proposal / bankruptcy on file." };
  }
  if (cpStatus === "active") {
    return {
      status: STATUS.UNCONFIRMED,
      note: "Active (undischarged) CP/BK — most alt-B/institutional lenders require discharge first; confirm this lender's policy directly.",
    };
  }
  // discharged
  if (lender.cpBkSeasoningMonths == null) {
    return { status: STATUS.UNCONFIRMED, note: "No seasoning policy published — confirm directly." };
  }
  const months = monthsSinceDischarge == null ? -1 : monthsSinceDischarge;
  if (months >= lender.cpBkSeasoningMonths) {
    return {
      status: STATUS.PASS,
      note: lender.cpBkSeasoningMonths === 0
        ? "No seasoning requirement noted."
        : `Clears the ${lender.cpBkSeasoningMonths}-month seasoning requirement.`,
    };
  }
  return {
    status: STATUS.FAIL,
    note: `Requires ~${lender.cpBkSeasoningMonths} months since discharge; file has ${months < 0 ? "unknown" : months}.`,
  };
}

function checkIncomeDocs(lender, hasIncomeDocs) {
  if (hasIncomeDocs == null) return { status: STATUS.NA, note: "Not specified." };
  if (lender.incomeDocsRequired && !hasIncomeDocs) {
    return { status: STATUS.FAIL, note: "Lender requires income verification; file is equity-based/no-income." };
  }
  if (lender.incomeDocsRequired && hasIncomeDocs) {
    return { status: STATUS.PASS, note: "Lender requires income docs and the file has them." };
  }
  return { status: STATUS.PASS, note: "Income docs not required by this lender." };
}

function checkCondition(lender, condition) {
  if (!condition) return { status: STATUS.NA, note: "Not specified." };
  const tolerance = lender.conditionTolerance || "unspecified";
  if (condition === "poor") {
    if (tolerance === "low") {
      return { status: STATUS.FAIL, note: "Low condition tolerance — has declined files over condition before." };
    }
    return {
      status: STATUS.UNCONFIRMED,
      note: "Condition tolerance not confirmed for poor condition — have photos/contractor estimate ready.",
    };
  }
  if (condition === "fair" && tolerance === "low") {
    return {
      status: STATUS.UNCONFIRMED,
      note: "Low condition tolerance on record — flag condition proactively before submitting.",
    };
  }
  return { status: STATUS.PASS, note: "No condition concern flagged for this file." };
}

// file: { region, ltv, credit, cpStatus, cpMonths, hasIncomeDocs, condition }
function screenLender(lender, file) {
  const checks = {
    region: checkRegion(lender, file.region),
    ltv: checkLTV(lender, file.ltv),
    credit: checkCredit(lender, file.credit),
    cpBk: checkCpBk(lender, file.cpStatus, file.cpMonths),
    incomeDocs: checkIncomeDocs(lender, file.hasIncomeDocs),
    condition: checkCondition(lender, file.condition),
  };

  const values = Object.values(checks);
  const hasFail = values.some((c) => c.status === STATUS.FAIL);
  const passCount = values.filter((c) => c.status === STATUS.PASS).length;
  const unconfirmedCount = values.filter((c) => c.status === STATUS.UNCONFIRMED).length;

  const relevantDeclines = (lender.declines || []).filter((d) => {
    if (!file.region) return false;
    return norm(d.region).includes(norm(file.region)) || norm(file.region).includes(norm(d.region));
  });

  return {
    lender,
    checks,
    excluded: hasFail,
    passCount,
    unconfirmedCount,
    relevantDeclines,
  };
}

function screenAllLenders(file) {
  const results = LENDER_DATA.map((lender) => screenLender(lender, file));

  const included = results.filter((r) => !r.excluded);
  const excluded = results.filter((r) => r.excluded);

  included.sort((a, b) => {
    if (b.passCount !== a.passCount) return b.passCount - a.passCount;
    return a.unconfirmedCount - b.unconfirmedCount;
  });

  return { included, excluded };
}
