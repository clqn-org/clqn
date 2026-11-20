# Publishing a release

The npm package is `clqn-cli`; its executable is `clqn`. It bundles the CLI, MCP adapter, shared client, and runtime dependencies. The same archive goes to GitHub Releases for this repository's Homebrew tap. Keep older release assets for existing installations.

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

Packaging generates the formula's SHA-256. The package test installs the archive offline and checks CLI/MCP behavior. Publish that exact tested archive without rebuilding.

## Publish

Authenticate with `npm login` and `gh auth login`. Commit and push release changes, including the generated formula. Replace the example version:

```sh
git tag v0.1.0
git push origin main v0.1.0
npm publish ./dist/clqn-cli-0.1.0.tgz --access public
gh release create v0.1.0 ./dist/clqn-cli-0.1.0.tgz --verify-tag --title 'clqn 0.1.0' --generate-notes
```

An npm version cannot be reused. If a later step fails, resume it with the same archive.

## Verify

```sh
npm view clqn-cli version
npm install -g clqn-cli
clqn --version
brew tap rli8145/clqn https://github.com/rli8145/clqn
brew install rli8145/clqn/clqn
brew test rli8145/clqn/clqn
```

Package publication does not deploy `website/download.html`.
