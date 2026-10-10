// Conventional Commits (docs/commits.md). Checked on every commit by the
// commit-msg hook and on every pull request title by CI, since squash merges
// turn the title into the commit on main.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Long URLs and stack traces belong in bodies and footers: warn only.
    'body-max-line-length': [1, 'always', 100],
    'footer-max-line-length': [1, 'always', 100],
  },
};
