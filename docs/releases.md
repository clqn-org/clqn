# Publishing a release

The public npm package is `clqn-cli`; its executable is `clqn`. npm rejects the name `clqn` as too similar to existing packages. The CLI, MCP adapter, shared client, and runtime dependencies are bundled together; the workspace packages stay private. The same archive is attached to a GitHub release for the Homebrew tap in this repository. This tap is independent of Homebrew core.

The v0.1.0 release also contains earlier archives with the same CLI bundle. Keep those assets available for existing Homebrew installations.

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

The package test installs the archive offline into a temporary prefix, checks the CLI, and calls the bundled MCP server. Packaging also generates the formula with the archive's SHA-256. Finish any README changes before packaging because the README is included in the archive. Publish the exact archive that was tested; do not rebuild between npm and GitHub publication.

## Publish

Authenticate with `npm login` and `gh auth login` first. Commit the release changes, including the generated formula, then push them. Substitute the version below for subsequent releases.

```sh
git tag v0.1.0
git push origin main v0.1.0
npm publish ./dist/clqn-cli-0.1.0.tgz --access public
gh release create v0.1.0 ./dist/clqn-cli-0.1.0.tgz --verify-tag --title 'clqn 0.1.0' --generate-notes
```

If npm requests account verification, complete its browser flow. A published npm version cannot be reused. If a later step fails, resume that step with the same archive rather than publishing again.

## Verify

```sh
npm view clqn-cli version
npm install -g clqn-cli
clqn --version
brew tap rli8145/clqn https://github.com/rli8145/clqn
brew install rli8145/clqn/clqn
brew test rli8145/clqn/clqn
```

The static download page source lives in `website/download.html`; publishing a package does not deploy that website.
