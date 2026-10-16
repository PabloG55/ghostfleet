# Releasing to npm

How a release goes from `staging` to `ghostfleet-cli` on npm, in the order it actually has
to happen. Every step below is here because skipping it has cost a release something:
a version that was merged and never published, a merge that GitHub refused, a publish that
uploaded nothing and exited 0.

The package is **`ghostfleet-cli`**. `ghostfleet` on npm belongs to an unrelated project.

## 0. Before you start

- `npm view ghostfleet-cli dist-tags` — what npm has now. Compare it with the newest
  `## x.y.z` heading in `CHANGELOG.md`. They can disagree: 0.5.1 was merged to `main` and
  tagged, and never reached npm, because the publish was the step left for later. 0.6.0
  then carried it. If they disagree, the new release's changelog says so.
- `git log --oneline origin/main..origin/staging` — what this release carries.
- Pick the version. Anything that adds a feature is a minor bump while we are on `0.x`;
  a release of fixes alone is a patch.

## 1. Release prep PR, against `staging`

One PR, two files, the same shape as #36 and #61:

- `package.json` — `"version"`.
- `CHANGELOG.md` — rename `## Unreleased` to `## x.y.z — YYYY-MM-DD` and make sure every
  merged PR since the last *published* version that changed something a user would see has
  an entry naming its number. Open with what to restart after upgrading (long-lived
  processes keep old code: a Claude session's mod and MCP server, `fleet-serve`, the
  installed phone app), because that is what an upgrader trips on first.

Title it `Release prep x.y.z: <why this release>`. Merge it like any other PR — squash,
explicit `--subject`/`--body-file`, both suite legs green.

## 2. `staging` → `main`, as a merge commit

```bash
gh pr create --base main --head staging --title "Release x.y.z" --body-file <body>
```

It has to be a **merge commit**, never a squash (CONTRIBUTING.md says why). But the repo
setting allows **squash only**, so `gh pr merge --merge` is refused with
`Merge commits are not allowed on this repository`. Turn merge commits on for the one
merge and straight back off:

```bash
gh api -X PATCH repos/PabloG55/ghostfleet -F allow_merge_commit=true
gh pr merge <N> --merge --match-head-commit <full staging sha> \
  --subject "Release x.y.z (#<N>)" --body-file <body>
gh api -X PATCH repos/PabloG55/ghostfleet -F allow_merge_commit=false
```

Run the three as one block so the setting cannot be left on. Then prove it took:

```bash
git fetch origin
git log -1 --format='%h %p %s' origin/main          # two parents
git merge-base --is-ancestor origin/staging origin/main && echo ok
git show origin/main:package.json | grep '"version"'
```

**A red check on `staging` blocks this PR even when the PR's own checks are green.** The
push-triggered run on the release-prep commit reports under the same check names, and the
branch policy counts it. Read the failure first: if it is a known flaky row and not the
release, re-run that job (`gh run rerun <id> --failed`) rather than reaching for `--admin`.

## 3. Tag

```bash
git tag -a vx.y.z -m x.y.z origin/main
git push origin vx.y.z
```

Annotated, on `origin/main`, never on a local branch. Park the main checkout on the new
tag afterwards (`git checkout vx.y.z`) — and do any `cf-sync`/`./install.sh` *before*
that, from `staging`, because both sync whatever is checked out.

## 4. Look at what will actually ship

The tree passed the name sweep; the tarball is a different artifact, and it is the one
that goes public. Build it and read it:

```bash
P="$(mktemp -d)"
npm pack --pack-destination "$P"
tar -xzf "$P"/ghostfleet-cli-*.tgz -C "$P"
# every file in it is tracked (nothing built or stray slipped in):
(cd "$P/package" && find . -type f | sed 's#^\./##') |
  while read -r f; do git ls-files --error-unmatch "$f" >/dev/null 2>&1 || echo "UNTRACKED $f"; done
# and nothing private is in it: your real tailnet suffix and IP, your email, work names
grep -rIF -c "<your tailnet suffix>" "$P/package" | grep -v ':0$'
```

Expected matches that are fine: `/Users/you`, `100.64.0.0/10` (Tailscale's range) and the
invented example hostnames the suite's name sweep allows. Note the `integrity` line
`npm pack` prints — step 6 checks the registry against it.

## 5. Log in, in a browser

```bash
npm login --auth-type=web
npm whoami
```

No tokens. The login prints a URL, you approve it in the browser, and `whoami` names the
account.

## 6. Publish — from a real terminal

```bash
cd <the checkout, parked on vx.y.z, clean>
npm publish
```

`prepublishOnly` runs `vite build` and the whole suite first, so this takes minutes. Then
npm asks for a second factor, and **that step needs a real terminal**:

- Run from an agent's shell or Claude Code's `!` prefix, there is no TTY, so npm prints
  `EOTP … Open this URL in your browser to authenticate` and **exits** instead of waiting.
  The URL is masked as `***` in that output, so it cannot even be opened. Nothing is
  uploaded. And under a pipe (`| tee`) the exit status is 0, so it looks like it worked.
- In a normal terminal window, npm opens the URL, waits while you approve, and uploads.
- Or pass a code from an authenticator app: `npm publish --otp=123456` works anywhere.

If the suite already passed on this exact tree and `git status` is still clean after the
build (the committed build matched its source), `npm publish --ignore-scripts` skips
re-running both.

## 7. Prove it is on npm

The upload returns `PUT 202` (accepted), and the version is **not visible for a few
minutes**: 0.6.0 took about three, and `npm view` without `--prefer-online` answered from
cache for longer. Don't call it failed, and don't publish again; check the registry:

```bash
npm view ghostfleet-cli dist-tags --prefer-online
curl -s https://registry.npmjs.org/ghostfleet-cli | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s),v=j.versions["x.y.z"];
  console.log(j["dist-tags"].latest, j.time["x.y.z"], v&&v.dist.integrity, v&&v.dist.fileCount)})'
```

Done when `latest` is the new version and its `integrity` is the one `npm pack` printed in
step 4. If `latest` is still the old one after ten minutes, read the newest
`~/.npm/_logs/*-debug-0.log` from the publish: a `PUT 202` means it went up, a `PUT 401`
with no later `202` means the second factor never completed.
