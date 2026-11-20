# Publishing a release

The public npm package is `clqn-cli`; its executable is `clqn`. npm rejects the name `clqn` as too similar to existing packages. The CLI, MCP adapter, shared client, and runtime dependencies are bundled together; the workspace packages stay private. The same archive is attached to a GitHub release for the Homebrew tap in this repository. This tap is independent of Homebrew core.

The v0.1.0 release also contains earlier archives with the same CLI bundle. Keep those assets available for existing Homebrew installations.

## Configure release access once

1. Under GitHub **Settings → Environments**, create `cli-release` and allow deployments from **tags** matching `v*`. To reserve release tags for specific maintainers, configure a GitHub tag ruleset for `v*`.
2. In the npm package settings for `clqn-cli`, add a GitHub Actions trusted publisher. Enter owner `rli8145`, repository `clqn`, workflow filename `ci.yml`, and environment `cli-release`. The job uses a short-lived OIDC identity and the repository's built-in GitHub token. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

## Prepare

Start from a clean checkout with Node.js 22+ and npm 10+. For a new version, update the workspace versions, internal dependency versions, lockfile, and `VERSION` in `packages/shared/src/index.ts` together.

```sh
npm ci
npm test
npm run typecheck
npm run package:cli
npm run test:package
cp dist/clqn.rb Formula/clqn.rb
```

The package test installs the archive offline into a temporary prefix, checks the CLI, and calls the bundled MCP server. Packaging generates the formula with the archive's SHA-256. Finish README changes first because the archive includes the README. CI also provides a `cli-release` artifact with the tested Node.js 22 archive and formula. If local platform or toolchain differences produce another checksum, use `clqn.rb` from the release commit's CI build in `Formula/clqn.rb` before tagging.

## Publish

Merge the release changes, including the generated formula, into `main`. A release maintainer creates a new stable version tag on that commit. For example, to release 0.1.1 from the current remote main:

```sh
git fetch origin main
git tag v0.1.1 origin/main
git push origin refs/tags/v0.1.1
```

A tag push runs the full CI matrix. The release job checks that the tag points to a commit on `main`, that its version matches the packed manifest, and that the committed formula names and hashes the tested archive. It stages those bytes on a draft GitHub release, verifies the uploaded asset, publishes the same archive to npm with provenance, then makes the GitHub release public.

If the job fails partway, rerun failed jobs for the original tag. CI keeps the tested artifact for seven days. After that, rerun all jobs for the original tag to rebuild and verify its committed checksum. A retry checks an existing npm version's SHA-512 integrity and downloads any existing GitHub asset to compare its bytes before continuing. A checksum conflict stops publication and requires investigation.

## Verify

```sh
npm view clqn-cli version
npm install -g clqn-cli
clqn --version
brew tap rli8145/clqn https://github.com/rli8145/clqn
brew install rli8145/clqn/clqn
brew test rli8145/clqn/clqn
```

The static download page source lives in `website/download.html`. Changes to it ship through the [website deployment workflow](hosting.md#automatic-website-deployment) after checks pass on `main`.
