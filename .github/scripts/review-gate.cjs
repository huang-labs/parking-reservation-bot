const OVERRIDE_LABEL = "ai-review-override";

function evaluateReview(raw, outcome) {
  if (outcome !== "success") {
    return { pass: false, message: "PR-Agent failed; fix the review run or explicitly override it." };
  }
  let review;
  try {
    review = JSON.parse(raw);
  } catch {
    return { pass: false, message: "PR-Agent did not return valid structured review output." };
  }
  if (!review || !Array.isArray(review.key_issues_to_review) ||
      !["no_concerns_found", "needs_review", "changes_required"].includes(review.merge_recommendation)) {
    return { pass: false, message: "PR-Agent output is missing findings or a valid merge recommendation." };
  }
  const count = review.key_issues_to_review.length;
  const pass = count === 0 && review.merge_recommendation === "no_concerns_found";
  return {
    pass,
    message: pass ? "PR-Agent found no actionable concerns." :
      `PR-Agent requires attention: ${count} finding(s), recommendation ${review.merge_recommendation}. Address the review and push to rerun.`,
  };
}

async function currentPull(github, context) {
  const { data } = await github.rest.pulls.get({
    ...context.repo, pull_number: context.payload.pull_request.number,
  });
  return data;
}

function hasOverride(pull) {
  return pull.labels.some((label) => label.name === OVERRIDE_LABEL);
}

// Bind the label to the head at the time it was added. A stale label must not
// authorize a new head if a concurrent label event replaces the push's reset job.
async function currentOverride(github, context, pull) {
  if (!hasOverride(pull)) return false;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo, issue_number: pull.number, per_page: 100,
  });
  const latest = comments.filter((comment) =>
    comment.user?.login === "github-actions[bot]" && comment.user?.type === "Bot" &&
    /^<!-- ai-review-override:([^\s]+) -->\n/.test(comment.body || "")
  ).at(-1);
  return latest?.body.startsWith(`<!-- ai-review-override:${pull.head.sha} -->\n`) || false;
}

async function prepare({ github, context, core }) {
  let pull = await currentPull(github, context);
  if (pull.head.sha !== context.payload.pull_request.head.sha || pull.state !== "open") {
    core.notice("Skipping a superseded or closed PR event.");
    return;
  }
  // This API write uses GITHUB_TOKEN, so it does not recursively trigger this workflow.
  if (["opened", "reopened", "ready_for_review", "synchronize"].includes(context.payload.action) && hasOverride(pull)) {
    try {
      await github.rest.issues.removeLabel({
        ...context.repo, issue_number: pull.number, name: OVERRIDE_LABEL,
      });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    pull = await currentPull(github, context);
  }
  if (context.payload.action === "labeled" &&
      context.payload.label?.name === OVERRIDE_LABEL && hasOverride(pull)) {
    await github.rest.issues.createComment({
      ...context.repo, issue_number: pull.number,
      body: `<!-- ai-review-override:${pull.head.sha} -->\nAI review overridden for ${pull.head.sha} by @${context.payload.sender.login} using the \`${OVERRIDE_LABEL}\` label. This does not override test or preview checks.`,
    });
  }
  core.setOutput("current", "true");
  core.setOutput("override", String(await currentOverride(github, context, pull)));
}

async function enforce({ github, context, core, raw, outcome }) {
  const pull = await currentPull(github, context);
  if (pull.head.sha !== context.payload.pull_request.head.sha || pull.state !== "open") {
    core.notice("This result is superseded; the current PR head needs its own review.");
    return;
  }
  const result = await currentOverride(github, context, pull)
    ? { pass: true, message: `AI review explicitly overridden by ${OVERRIDE_LABEL} for ${pull.head.sha}. See the PR label timeline for the actor.` }
    : evaluateReview(raw, outcome);
  await core.summary.addHeading("AI review gate").addRaw(result.message).write();
  if (result.pass) core.notice(result.message);
  else core.setFailed(result.message);
}

module.exports = { OVERRIDE_LABEL, evaluateReview, prepare, enforce };
