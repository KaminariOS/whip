const { execFileSync } = require('node:child_process');

const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;

function resolveGitCommit() {
  const environmentCommit = [
    process.env.WHIP_GIT_COMMIT,
    process.env.GITHUB_SHA,
    process.env.EAS_BUILD_GIT_COMMIT_HASH,
  ].find(value => value && COMMIT_PATTERN.test(value.trim()));

  if (environmentCommit) {
    return environmentCommit.trim();
  }

  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return COMMIT_PATTERN.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

module.exports = ({ config }) => {
  const gitCommit = resolveGitCommit();

  return {
    ...config,
    plugins: [
      ...(config.plugins || []),
      ...((config.plugins || []).includes('expo-sqlite') ? [] : ['expo-sqlite']),
    ],
    extra: {
      ...config.extra,
      ...(gitCommit ? { gitCommit } : {}),
    },
  };
};
