const { test } = require("node:test");
const assert = require("node:assert/strict");
const { evaluateReview, prepare, enforce, OVERRIDE_LABEL } = require("./review-gate.cjs");

const clean = { key_issues_to_review: [], merge_recommendation: "no_concerns_found" };
const evaluate = (review, outcome = "success") => evaluateReview(JSON.stringify(review), outcome);

test("only a successful, complete, concern-free review passes", () => {
  assert.equal(evaluate(clean).pass, true);
  for (const recommendation of ["needs_review", "changes_required"]) {
    assert.equal(evaluate({ ...clean, merge_recommendation: recommendation }).pass, false);
  }
  assert.equal(evaluate({ ...clean, key_issues_to_review: [{ issue_header: "Defect" }] }).pass, false);
});

test("missing, malformed, or failed reviews fail closed", () => {
  for (const raw of [undefined, "", "not json", "null", "{}", "[]", '{"key_issues_to_review":[]}']) {
    assert.equal(evaluateReview(raw, "success").pass, false);
  }
  for (const outcome of ["failure", "skipped", "cancelled", undefined]) {
    assert.equal(evaluateReview(JSON.stringify(clean), outcome).pass, false);
  }
  assert.equal(evaluate({ ...clean, merge_recommendation: "approved" }).pass, false);
});

function fixture({ action = "opened", sha = "head", label = false, state = "open" } = {}) {
  const pull = { number: 12, head: { sha }, state, labels: label ? [{ name: OVERRIDE_LABEL }] : [] };
  const comments = [];
  const calls = { comments, removed: [], outputs: {}, failures: [], notices: [], summaries: [] };
  const github = { rest: {
    pulls: { get: async () => ({ data: pull }) },
    issues: {
      listComments: () => {},
      createComment: async ({ body }) => comments.push({ body, user: { login: "github-actions[bot]", type: "Bot" } }),
      removeLabel: async (args) => { calls.removed.push(args); pull.labels = []; } },
  } };
  github.paginate = async () => comments;
  const context = { repo: { owner: "owner", repo: "repo" }, payload: {
    action, label: { name: OVERRIDE_LABEL }, sender: { login: "owner" }, pull_request: { number: 12, head: { sha: "head" } },
  } };
  const summary = {
    addHeading() { return this; }, addRaw(message) { calls.summaries.push(message); return this; },
    async write() {},
  };
  const core = {
    summary, setOutput: (key, value) => { calls.outputs[key] = value; },
    notice: (message) => calls.notices.push(message), setFailed: (message) => calls.failures.push(message),
  };
  return { github, context, core, pull, calls };
}

test("new commits and returning to review clear the override before inference", async () => {
  for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
    const f = fixture({ action, label: true });
    await prepare(f);
    assert.equal(f.calls.removed.length, 1);
    assert.deepEqual(f.calls.outputs, { current: "true", override: "false" });
  }
});

test("label addition preserves the override and skips paid inference", async () => {
  const f = fixture({ action: "labeled", label: true });
  await prepare(f);
  assert.equal(f.calls.outputs.override, "true");
  assert.equal(f.calls.removed.length, 0);
  await enforce({ ...f, outcome: "skipped", raw: "" });
  assert.equal(f.calls.failures.length, 0);
  assert.match(f.calls.summaries[0], /explicitly overridden/);
});

test("removing the label requires a fresh successful review", async () => {
  const f = fixture({ action: "unlabeled" });
  await prepare(f);
  assert.equal(f.calls.outputs.override, "false");
  await enforce({ ...f, outcome: "skipped", raw: "" });
  assert.equal(f.calls.failures.length, 1);
});

test("the final gate reads live labels instead of trusting an earlier override", async () => {
  const f = fixture({ action: "labeled", label: true });
  await prepare(f);
  f.pull.labels = [];
  await enforce({ ...f, outcome: "skipped", raw: "" });
  assert.equal(f.calls.failures.length, 1);
});

test("provider failure can be explicitly overridden", async () => {
  const f = fixture({ action: "labeled", label: true });
  await prepare(f);
  await enforce({ ...f, outcome: "failure", raw: "" });
  assert.equal(f.calls.failures.length, 0);
});

test("old head and closed events cannot remove labels or enforce a stale review", async () => {
  for (const options of [{ sha: "new-head" }, { state: "closed" }]) {
    const f = fixture({ ...options, action: "synchronize", label: true });
    await prepare(f);
    await enforce({ ...f, outcome: "failure", raw: "" });
    assert.deepEqual(f.calls.outputs, {});
    assert.equal(f.calls.removed.length, 0);
    assert.equal(f.calls.failures.length, 0);
    assert.equal(f.calls.summaries.length, 0);
  }
});

test("label API errors fail the reset instead of carrying an override forward", async () => {
  const f = fixture({ action: "synchronize", label: true });
  f.github.rest.issues.removeLabel = async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); };
  await assert.rejects(prepare(f), /Forbidden/);
  assert.deepEqual(f.calls.outputs, {});
});

test("a concurrently removed label is harmless", async () => {
  const f = fixture({ action: "synchronize", label: true });
  f.github.rest.issues.removeLabel = async () => {
    f.pull.labels = [];
    throw Object.assign(new Error("Not found"), { status: 404 });
  };
  await prepare(f);
  assert.equal(f.calls.outputs.override, "false");
});

test("a stale label cannot authorize a new head when another label event replaces the push run", async () => {
  const f = fixture({ action: "labeled", label: true });
  await prepare(f);
  f.pull.head.sha = "new-head";
  f.context.payload.pull_request.head.sha = "new-head";
  f.context.payload.label.name = "unrelated-label";
  await prepare(f);
  assert.equal(f.calls.outputs.override, "false");
  await enforce({ ...f, outcome: "skipped", raw: "" });
  assert.equal(f.calls.failures.length, 1);
  assert.equal(f.calls.comments.length, 1);
});

test("an override marker from a user is not trusted", async () => {
  const f = fixture({ action: "unlabeled", label: true });
  f.calls.comments.push({ body: "<!-- ai-review-override:head -->\n", user: { login: "owner", type: "User" } });
  await prepare(f);
  assert.equal(f.calls.outputs.override, "false");
});

test("the gate passes clean output and fails findings through the workflow entry point", async () => {
  for (const count of [0, 1]) {
    const f = fixture();
    await enforce({ ...f, outcome: "success", raw: JSON.stringify({
      ...clean, key_issues_to_review: Array(count).fill({ issue_header: "Defect" }),
    }) });
    assert.equal(f.calls.failures.length, count);
  }
});

test("live review exported by the pinned PR-Agent serializer matches the gate contract", () => {
  const captured = require("./fixtures/pr-agent-review.json");
  const result = evaluateReview(captured.action_output, "success");
  assert.equal(result.pass, captured.expected_pass);
  assert.doesNotMatch(result.message, /valid structured review output|missing findings/);
});
