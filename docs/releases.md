# Publishing a release

The npm package is `clqn-cli`; its executable is `clqn`. It bundles the CLI, MCP adapter, shared client, and runtime dependencies. The same archive goes to GitHub Releases for this repository's Homebrew tap. Keep older release assets for existing installations.

## Configure release access

1. Under GitHub **Settings → Environments**, create `cli-release` and allow deployments from tags matching `v*`. To reserve release tags for specific maintainers, configure a `v*` tag ruleset.
2. In the npm settings for `clqn-cli`, add a GitHub Actions trusted publisher for owner `rli8145`, repository `clqn`, workflow filename `ci.yml`, and environment `cli-release`. The workflow uses npm's short-lived OIDC credential and GitHub's built-in token. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

## Prepare

Start from a clean checkout with Node.js 22+ and npm 10+. Update workspace versions, internal dependency versions, the lockfile, and `VERSION` in `packages/shared/src/index.ts` together. Finish README edits before packaging; it is included in the archive.

```sh
npm ci
npm test
npm run typecheck
npm run package:cli
npm run test:package
cp dist/clqn.rb Formula/clqn.rb
```

Packaging generates the formula's SHA-256. The package test installs the archive offline and checks CLI/MCP behavior. CI saves the tested Node.js 22 archive and formula in its `cli-release` artifact. If your local checksum differs, copy the artifact's `clqn.rb` to `Formula/clqn.rb` before tagging.

## Publish

Merge release changes, including the generated formula, into `main`. Tag that commit with the new stable version. For example, to release 0.1.1 from the current remote main:

```sh
git fetch origin main
git tag v0.1.1 origin/main
git push origin refs/tags/v0.1.1
```

The tag runs the full CI matrix. The release job checks main ancestry, the packed version, and the committed formula's URL and checksum. It uploads and verifies the GitHub draft asset, publishes the same bytes to npm with provenance, then makes the release public.

Rerun failed jobs for the original tag after an interruption. After the seven-day artifact retention period, rerun all jobs for the tag. A retry compares the archive with any published npm version and GitHub asset. A checksum conflict stops publication.

## Verify

```sh
npm view clqn-cli version
npm install -g clqn-cli
clqn --version
brew tap rli8145/clqn https://github.com/rli8145/clqn
brew install rli8145/clqn/clqn
brew test rli8145/clqn/clqn
```

Changes to `website/download.html` ship through the [website deployment workflow](hosting.md#automatic-website-deployment) after checks pass on `main`.
