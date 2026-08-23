# Credentials a release needs but a repository must never carry — `YEPNOPE_DEPLOYMENT_PASSKEY` above
# all — live in a gitignored `.env`. Loading it here is what lets `just release` run unattended.
set dotenv-load := true

# `just --list --unsorted`
[group('default')]
default:
    @just --list --unsorted

ci := env("CI", "")

# Install dependencies
[group('setup')]
install:
    vp install
    vp fmt CLAUDE.md

# Run dev server
dev *args: install
    vp dev {{args}}

# Run linter
lint: install
    vp lint {{ if ci != "" { "--format github" } else { "--fix" } }}

# Run formatter
format: install
    vp fmt {{ if ci != "" { "--check" } else { "" } }}

# Run checks (format + lint + typecheck)
check *args: install
    vp run --cache check {{ if ci != "" { "" } else { "--fix" } }} {{args}}

# Run tests
test *args: install
    vp run --cache test:run {{args}}

# Type-check the project
typecheck: install
    vp run --cache typecheck

# Build the project
build: install
    vp run --cache build

# Apply safe Fallow fixes locally, then reject remaining dead code
fallow: install
    {{ if ci == "" { "vp run fallow" } else { "true" } }}
    vp run fallow:ci

# vp run fallow:ci
fallow-check: install
    vp run fallow:ci

# Run Storybook
storybook *args: install
    vp run storybook {{args}}

# Run pre-commit hooks on all files (same as CI's pre-commit job)
pre-commit: install
    pre-commit run --all-files

# Run all pre-commit checks
[arg("quick", long, value="true", help="Skip tests")]
verify quick="": check build fallow pre-commit
    {{ if quick != "true" { "just test" } else { "true" } }}
    @echo "All pre-commit checks passed!"

# Deprecated alias for `verify`
[arg("quick", long, value="true", help="Skip tests")]
precommit quick="": (verify quick)

# Verify, tag, deploy to production, and push the release tag
# Depends on `build` because the deployment preflight resolves the configuration with
# `wrangler deploy --dry-run`, which reads the built asset directory.
[group('release')]
[arg("dry-run", long, value="true", help="Print the release plan and the deployment preflight without verifying, tagging, or deploying")]
release dry-run="": build
    node --experimental-strip-types scripts/release.ts {{ if dry-run == "true" { "--dry-run" } else { "" } }}

# Deploy this tree to the staging Worker the release rehearses on
[group('release')]
deploy-staging: build
    vp exec wrangler deploy --config wrangler.staging.jsonc

# Prove the core loop on a deployment: OAuth, a blocking ask_yep_nope, and a deck that answers it
[group('release')]
[arg("origin", help="Deployment to check; defaults to $YEPNOPE_DEPLOYMENT_ORIGIN")]
check-deployment origin="": install
    {{ if origin != "" { "YEPNOPE_DEPLOYMENT_ORIGIN=" + origin } else { "" } }} node --experimental-strip-types scripts/deployment-check.ts

# Enroll the passkey the deployed core-loop check signs in with; pass a session to skip the browser
[group('release')]
[arg("origin", help="Deployment to enroll on; defaults to $YEPNOPE_DEPLOYMENT_ORIGIN")]
[arg("session", help="better-auth.session_token from your own signed-in browser; omit to open one")]
enroll-deployment-passkey origin="" session="": install
    {{ if origin != "" { "YEPNOPE_DEPLOYMENT_ORIGIN=" + origin } else { "" } }} {{ if session != "" { "YEPNOPE_DEPLOYMENT_SESSION=" + session } else { "" } }} node --experimental-strip-types scripts/deployment-check.ts --enroll
